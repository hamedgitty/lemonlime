import { useCallback, useEffect, useRef, useState } from "react";
import { RunnerClient } from "@lemonlime/client";
import { signToken, type Thread, type ThreadEvent, type ThreadStatus } from "@lemonlime/protocol";
import { appendEvents, contiguousSeq, type PendingMessage } from "./timeline.ts";
import { forgetEvents, loadEvents, saveEvents, type LocalThreadMeta } from "./storage.ts";
import { isLocalRunnerRunning, startLocalRunner } from "./native.ts";
import type { CloudApi } from "./cloud.ts";
import { joinCommand } from "./command.ts";

export type SessionState =
  /** Starting the local runner or asking the control plane where to connect. */
  | "starting"
  | "connecting"
  | "live"
  | "reconnecting"
  /** Nothing to connect to: runner stopped, or cloud sandbox paused. */
  | "offline"
  | "error";

export type SessionTarget = { mode: "local"; meta: LocalThreadMeta; runnerPath: string } | { mode: "cloud"; thread: Thread; api: CloudApi };

export interface SessionCallbacks {
  /** Called (debounced) when new events have been stored. */
  onProgress?: (threadId: string, lastSeq: number) => void;
  onStatus?: (threadId: string, status: ThreadStatus) => void;
  /** Local threads: the first prompt has been handed to the runner. */
  onPromptSent?: (threadId: string) => void;
}

interface Connection {
  url: string;
  token: () => Promise<string>;
}

const CLIENT_TOKEN_TTL_S = 10 * 60;

export interface ThreadSession {
  events: ThreadEvent[];
  pending: PendingMessage[];
  state: SessionState;
  error: string | null;
  /** Status from the runner (welcome + status changes). */
  status: ThreadStatus | null;
  send: (text: string) => void;
  interrupt: () => void;
  /** Answer the agent's request for permission. */
  approve: (requestId: string, decision: "allow" | "deny") => void;
  /** Tear down and connect again (starting the local runner if needed). */
  restart: () => void;
  /** Close the connection on purpose and show the thread as offline. */
  disconnect: () => void;
}

/** Owns the RunnerClient for one thread. Mount it with `key={threadId}`. */
export function useThreadSession(target: SessionTarget, callbacks: SessionCallbacks): ThreadSession {
  const threadId = target.mode === "local" ? target.meta.id : target.thread.id;

  const [events, setEvents] = useState<ThreadEvent[]>(() => loadEvents(threadId));
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [state, setState] = useState<SessionState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ThreadStatus | null>(null);
  const [generation, setGeneration] = useState(0);

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const targetRef = useRef(target);
  targetRef.current = target;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const clientRef = useRef<RunnerClient | null>(null);
  const forceFullReplay = useRef(false);
  const disconnectedRef = useRef(false);

  // Persist the cache and report progress, debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      saveEvents(threadId, events);
      const last = events.length > 0 ? events[events.length - 1]!.seq : 0;
      callbacksRef.current.onProgress?.(threadId, last);
    }, 400);
    return () => clearTimeout(t);
  }, [threadId, events]);

  // Flush on unmount so nothing is lost when switching threads quickly.
  useEffect(() => () => saveEvents(threadId, eventsRef.current), [threadId]);

  // Drop pending copies once the runner has echoed them back.
  useEffect(() => {
    if (pending.length === 0) return;
    const ids = new Set<string>();
    for (const e of events) if (e.type === "user_message" && e.clientMsgId) ids.add(e.clientMsgId);
    if (pending.some(p => ids.has(p.clientMsgId))) setPending(p => p.filter(x => !ids.has(x.clientMsgId)));
  }, [events, pending]);

  useEffect(() => {
    let cancelled = false;
    let client: RunnerClient | null = null;
    let buffer: ThreadEvent[] = [];
    let flushHandle: ReturnType<typeof setTimeout> | null = null;
    let checkingRunner = false;

    const flush = () => {
      flushHandle = null;
      const batch = buffer;
      buffer = [];
      if (!cancelled && batch.length > 0) setEvents(prev => appendEvents(prev, batch));
    };

    const updateStatus = (s: ThreadStatus) => {
      setStatus(s);
      callbacksRef.current.onStatus?.(threadId, s);
    };

    const run = async () => {
      disconnectedRef.current = false;
      setState("starting");
      setError(null);

      if (forceFullReplay.current) {
        forceFullReplay.current = false;
        forgetEvents(threadId);
        eventsRef.current = [];
        setEvents([]);
      }

      let conn: Connection | null;
      try {
        conn = await resolveConnection(targetRef.current);
      } catch (err) {
        if (cancelled) return;
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (cancelled) return;
      if (!conn) {
        setState("offline");
        return;
      }

      // Only resume from a gap-free prefix of what we have cached.
      const cached = eventsRef.current;
      const resumeFrom = contiguousSeq(cached);
      if (cached.length > 0 && cached[cached.length - 1]!.seq !== resumeFrom) {
        setEvents(cached.filter(e => e.seq <= resumeFrom));
      }

      client = new RunnerClient({
        url: conn.url,
        token: conn.token,
        resumeFrom,
        onWelcome: (thread, latestSeq) => {
          if (cancelled) return;
          updateStatus(thread.status);
          // The runner holds less history than we cached: its store was reset.
          if (latestSeq < resumeFrom) {
            forceFullReplay.current = true;
            setGeneration(g => g + 1);
          }
        },
        onEvent: ev => {
          if (cancelled) return;
          buffer.push(ev);
          if (ev.type === "status_change") updateStatus(ev.to);
          if (!flushHandle) flushHandle = setTimeout(flush, 16);
        },
        onState: s => {
          if (cancelled || disconnectedRef.current) return;
          if (s === "closed") return;
          setState(s);
          if (s === "live") setError(null);
          if (s === "reconnecting" && targetRef.current.mode === "local" && !checkingRunner) {
            checkingRunner = true;
            void isLocalRunnerRunning(threadId)
              .then(alive => {
                if (cancelled || alive) return;
                client?.close();
                setState("offline");
                setError("The runner for this thread has stopped.");
              })
              .finally(() => {
                checkingRunner = false;
              });
          }
        },
        onError: (message, code) => {
          if (cancelled) return;
          setError(code === "unauthorized" ? "The runner did not accept this app's token." : message);
        },
      });
      clientRef.current = client;
      client.connect();

      // Local threads carry their first prompt until it has been handed over.
      const t = targetRef.current;
      if (t.mode === "local" && t.meta.pendingPrompt) {
        const text = t.meta.pendingPrompt;
        callbacksRef.current.onPromptSent?.(threadId);
        const clientMsgId = newClientMsgId();
        setPending(p => [...p, { clientMsgId, text, at: new Date().toISOString() }]);
        client.send(text, clientMsgId);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (flushHandle) clearTimeout(flushHandle);
      if (buffer.length > 0) {
        const batch = buffer;
        buffer = [];
        setEvents(prev => appendEvents(prev, batch));
      }
      client?.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [threadId, generation]);

  const send = useCallback((text: string) => {
    const client = clientRef.current;
    const trimmed = text.trim();
    if (!client || !trimmed) return;
    const clientMsgId = newClientMsgId();
    setPending(p => [...p, { clientMsgId, text: trimmed, at: new Date().toISOString() }]);
    client.send(trimmed, clientMsgId);
  }, []);

  const interrupt = useCallback(() => clientRef.current?.interrupt(), []);
  const approve = useCallback((requestId: string, decision: "allow" | "deny") => clientRef.current?.approve(requestId, decision), []);
  const restart = useCallback(() => setGeneration(g => g + 1), []);
  const disconnect = useCallback(() => {
    disconnectedRef.current = true;
    clientRef.current?.close();
    clientRef.current = null;
    setState("offline");
    setError(null);
  }, []);

  return { events, pending, state, error, status, send, interrupt, approve, restart, disconnect };
}

function newClientMsgId(): string {
  return globalThis.crypto.randomUUID();
}

async function resolveConnection(target: SessionTarget): Promise<Connection | null> {
  if (target.mode === "local") {
    const { meta, runnerPath } = target;
    const info = await startLocalRunner({
      threadId: meta.id,
      agent: meta.agent.kind,
      agentCommand: meta.agent.command ? joinCommand(meta.agent.command) : undefined,
      model: meta.agent.model,
      workdir: meta.repoPath,
      baseBranch: meta.baseBranch,
      runnerPath,
    });
    return {
      url: `ws://127.0.0.1:${info.port}/ws`,
      token: () => signToken({ threadId: meta.id, scope: "client", sub: "desktop", exp: Math.floor(Date.now() / 1000) + CLIENT_TOKEN_TTL_S }, info.secret),
    };
  }

  const { api, thread } = target;
  const first = await api.getThread(thread.id);
  if (!first.endpoint) return null;
  let endpoint = first.endpoint;
  return {
    url: endpoint.url,
    token: async () => {
      // Reuse the issued token while it has at least 30 s left; otherwise ask for a new one.
      if (Date.parse(endpoint.expiresAt) - Date.now() > 30_000) return endpoint.token;
      const fresh = await api.getThread(thread.id);
      if (!fresh.endpoint) throw new Error("The sandbox for this thread is not running.");
      endpoint = fresh.endpoint;
      return endpoint.token;
    },
  };
}
