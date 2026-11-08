import { useCallback, useEffect, useRef, useState } from "react";
import { RunnerClient, runnerHttpBase, uploadAttachment } from "@lemonlime/client";
import {
  signToken,
  type ClientLimitAction,
  type ClientSetOptions,
  type ComputerRequest,
  type SideChatSummary,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
  type ThreadStatus,
} from "@lemonlime/protocol";
import { appendEvents, contiguousSeq, type PendingMessage } from "./timeline.ts";
import { forgetEvents, loadEvents, saveEvents, type LocalThreadMeta } from "./storage.ts";
import { confirmAction, isLocalRunnerRunning } from "./native.ts";
import { answerComputerRequest, type ComputerLevel } from "./computer.ts";
import type { CloudApi } from "./cloud.ts";
import { machineName, startThreadRunner } from "./threadRunner.ts";
import { deliverFirstMessage, forgetFirstMessage, peekFirstMessage } from "./firstMessage.ts";
import { newAttachmentId } from "./useAttachments.ts";

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

export interface LoginUpdate {
  state: "starting" | "open_url" | "needs_input" | "done" | "failed";
  url?: string;
  code?: string;
  message?: string;
}

export type EditQueuedFn = (
  clientMsgId: string,
  change: { action: "update"; text: string } | { action: "remove" } | { action: "move"; toIndex: number } | { action: "send_now" },
) => void;

export interface SessionCallbacks {
  /** Called (debounced) when new events have been stored. */
  onProgress?: (threadId: string, lastSeq: number) => void;
  onStatus?: (threadId: string, status: ThreadStatus) => void;
  /** Local threads: the first prompt has been handed to the runner. */
  onPromptSent?: (threadId: string) => void;
  /** Cloud threads: this thread's computer access setting, read when a request comes in. */
  computerLevel?: () => ComputerLevel;
}

export interface Connection {
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
  /** Send a message, with ids of finished uploads (live connections only). */
  /** `steer` sends it now (stopping the current turn) instead of queueing it. */
  send: (text: string, attachments?: string[], opts?: { steer?: boolean }) => void;
  interrupt: () => void;
  /** Answer the agent's request for permission. */
  approve: (requestId: string, decision: "allow" | "deny") => void;
  /** Where the runner is, while connected (the terminal opens its own socket there). */
  connection: Connection | null;
  /** Change a message waiting in the queue. */
  editQueued: EditQueuedFn;
  rewind: (toSeq: number, restoreFiles: boolean) => void;
  compact: () => void;
  /** The thread's model, reasoning and permission mode, as the runner last said (null before it has). */
  options: ThreadOptions | null;
  /** Change them from the agent's next turn. */
  setOptions: (change: Omit<ClientSetOptions, "type">) => void;
  /** Answer the agent's questions (one list per question), or decline with null. */
  answerQuestion: (requestId: string, answers: string[][] | null) => void;
  /** After a usage limit: another account, another agent, or wait for the reset. */
  limitAction: (action: Omit<ClientLimitAction, "type">) => void;
  /** Signing a cloud thread's agent in to the user's own account (never part of the history). */
  login: {
    update: LoginUpdate | null;
    start: () => void;
    input: (text: string) => void;
    cancel: () => void;
  };
  /** Side chats: read-only questions about the thread, outside its history. */
  side: {
    chats: SideChatSummary[];
    events: Record<string, ThreadEvent[]>;
    /** Ask in `sideId`, or in a new chat; resolves to the chat's id. */
    ask: (text: string, sideId?: string) => Promise<string>;
    pin: (sideId: string, pinned: boolean) => void;
    close: (sideId: string) => void;
    open: (sideId: string) => void;
  };
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
  const [options, setOptionsState] = useState<ThreadOptions | null>(null);
  const [generation, setGeneration] = useState(0);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loginUpdate, setLoginUpdate] = useState<LoginUpdate | null>(null);
  const [sideChats, setSideChats] = useState<SideChatSummary[]>([]);
  const [sideEvents, setSideEvents] = useState<Record<string, ThreadEvent[]>>({});
  const sideWaiters = useRef(new Map<string, (sideId: string) => void>());

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
        // A paused cloud thread: show what the control plane has kept, without waking it.
        const t = targetRef.current;
        if (t.mode === "cloud") {
          try {
            let after = contiguousSeq(eventsRef.current);
            for (let page = 0; page < 50 && !cancelled; page++) {
              const h = await t.api.history(t.thread.id, after);
              if (cancelled || h.events.length === 0) break;
              setEvents(prev => appendEvents(prev, h.events));
              after = h.events[h.events.length - 1]!.seq;
              if (!h.more) break;
            }
          } catch {
            /* stored history is a nice-to-have; the cache still shows */
          }
        }
        return;
      }

      // Only resume from a gap-free prefix of what we have cached.
      const cached = eventsRef.current;
      const resumeFrom = contiguousSeq(cached);
      if (cached.length > 0 && cached[cached.length - 1]!.seq !== resumeFrom) {
        setEvents(cached.filter(e => e.seq <= resumeFrom));
      }

      setConnection(conn);
      let markLive = () => {};
      const live = new Promise<void>((resolve, reject) => {
        markLive = resolve;
        // Torn down before it was live: the next connection hands the first message over.
        failLive = () => reject(new Error("closed"));
      });
      client = new RunnerClient({
        url: conn.url,
        token: conn.token,
        resumeFrom,
        onWelcome: (thread, latestSeq, current) => {
          if (cancelled) return;
          updateStatus(thread.status);
          if (current) setOptionsState(current);
          // The runner holds less history than we cached: its store was reset.
          if (latestSeq < resumeFrom) {
            forceFullReplay.current = true;
            setGeneration(g => g + 1);
          }
        },
        ...(targetRef.current.mode === "cloud"
          ? {
              onComputerRequest: (requestId: string, request: ComputerRequest) => {
                const level = callbacksRef.current.computerLevel?.() ?? "off";
                const t = targetRef.current;
                const id = t.mode === "local" ? t.meta.id : t.thread.id;
                void answerComputerRequest(level, request, confirmAction, id).then(r => client?.computerResult(requestId, r.ok, r.output));
              },
            }
          : {}),
        onLogin: update => !cancelled && setLoginUpdate(update),
        onSideChats: chats => !cancelled && setSideChats(chats),
        onSideEvent: (sideId, e) => !cancelled && setSideEvents(m => ({ ...m, [sideId]: [...(m[sideId] ?? []).filter(x => x.seq < e.seq), e] })),
        onSideHistory: (sideId, events) => !cancelled && setSideEvents(m => ({ ...m, [sideId]: events })),
        onSideStarted: (sideId, requestId) => {
          if (!requestId) return;
          sideWaiters.current.get(requestId)?.(sideId);
          sideWaiters.current.delete(requestId);
        },
        onEvent: ev => {
          if (cancelled) return;
          buffer.push(ev);
          if (ev.type === "status_change") updateStatus(ev.to);
          if (ev.type === "options_change") setOptionsState(ev.options);
          if (!flushHandle) flushHandle = setTimeout(flush, 16);
        },
        onState: s => {
          if (cancelled || disconnectedRef.current) return;
          if (s === "closed") return;
          setState(s);
          if (s === "live") {
            setError(null);
            markLive();
          }
          if (s === "reconnecting" && targetRef.current.mode === "local" && !checkingRunner) {
            checkingRunner = true;
            void isLocalRunnerRunning(threadId)
              .then(alive => {
                if (cancelled || alive) return;
                client?.close();
                setConnection(null);
                setState("offline");
                // Over SSH, the tunnel ending most often means the connection to the machine dropped.
                const t = targetRef.current;
                const machine = t.mode === "local" ? machineName(t.meta) : null;
                setError(machine ? `Can't reach ${machine}. The connection to it dropped.` : "The runner for this thread has stopped.");
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
      // After sleep or a dropped network, reconnect straight away instead of waiting.
      const wake = () => client?.reconnectNow();
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      document.addEventListener("visibilitychange", wake);
      removeWakeListeners = () => {
        window.removeEventListener("online", wake);
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", wake);
      };

      // Local threads carry their first prompt until it has been handed over. A thread started
      // from Home may also have files and a mode to start in, waiting for the runner.
      const t = targetRef.current;
      const first = peekFirstMessage(threadId);
      const text = t.mode === "local" ? t.meta.pendingPrompt : first?.text;
      if (first?.delivering) {
        /* already being handed over by an earlier connection */
      } else if (first && (first.files.length || first.permission)) {
        first.delivering = true;
        const clientMsgId = newClientMsgId();
        if (text) setPending(p => [...p, { clientMsgId, text, at: new Date().toISOString() }]);
        const sendTo = client;
        void deliverFirstMessage(first, text ?? "", {
          ready: () => live,
          setPermission: permission => sendTo.setOptions({ permission }),
          upload: (file, id) =>
            uploadAttachment({
              base: runnerHttpBase(conn.url),
              token: conn.token,
              file: Object.assign(file.slice(0, file.size, file.type), { name: file.name }),
              id,
            }).then(() => undefined),
          send: (msg, ids) => {
            if (t.mode === "local") callbacksRef.current.onPromptSent?.(threadId);
            sendTo.send(msg, clientMsgId, ids);
          },
          newId: newAttachmentId,
        }).then(
          ({ failed }) => {
            forgetFirstMessage(threadId);
            if (failed.length && !cancelled) setError(`Couldn't attach ${failed.map(f => f.name).join(", ")}: ${failed[0]!.error}`);
          },
          () => {
            first.delivering = false;
          },
        );
      } else if (text) {
        forgetFirstMessage(threadId);
        if (t.mode === "local") callbacksRef.current.onPromptSent?.(threadId);
        const clientMsgId = newClientMsgId();
        setPending(p => [...p, { clientMsgId, text, at: new Date().toISOString() }]);
        client.send(text, clientMsgId);
      }
    };

    let removeWakeListeners = () => {};
    let failLive = () => {};
    void run();

    return () => {
      cancelled = true;
      failLive();
      setConnection(null);
      removeWakeListeners();
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

  const send = useCallback((text: string, attachments: string[] = [], opts: { steer?: boolean } = {}) => {
    const client = clientRef.current;
    const trimmed = text.trim();
    if (!trimmed) return;
    const t = targetRef.current;
    if (!client && t.mode !== "cloud") return;
    const clientMsgId = newClientMsgId();
    setPending(p => [...p, { clientMsgId, text: trimmed, at: new Date().toISOString() }]);
    if (client) {
      client.send(trimmed, clientMsgId, attachments);
      // Steer: if it's waiting behind a running turn, run it now. A message that already started is left alone.
      if (opts.steer) client.editQueued(clientMsgId, { action: "send_now" });
      return;
    }
    // Paused cloud thread: the control plane keeps the message and wakes the sandbox,
    // whose runner picks it up; then we connect.
    if (t.mode !== "cloud") return;
    void t.api.sendWhilePaused(t.thread.id, { clientMsgId, text: trimmed }).then(
      () => setGeneration(g => g + 1),
      err => {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      },
    );
  }, []);

  const interrupt = useCallback(() => clientRef.current?.interrupt(), []);
  const approve = useCallback((requestId: string, decision: "allow" | "deny") => clientRef.current?.approve(requestId, decision), []);
  const editQueued = useCallback<EditQueuedFn>((id, change) => clientRef.current?.editQueued(id, change), []);
  const rewind = useCallback((toSeq: number, restoreFiles: boolean) => clientRef.current?.rewind(toSeq, restoreFiles), []);
  const compact = useCallback(() => clientRef.current?.compact(), []);
  const setOptions = useCallback((change: Omit<ClientSetOptions, "type">) => clientRef.current?.setOptions(change), []);
  const answerQuestion = useCallback((requestId: string, answers: string[][] | null) => clientRef.current?.answerQuestion(requestId, answers), []);
  const limitAction = useCallback((action: Omit<ClientLimitAction, "type">) => clientRef.current?.limitAction(action), []);
  const sideAsk = useCallback(
    (text: string, sideId?: string) =>
      new Promise<string>((resolve, reject) => {
        const client = clientRef.current;
        if (!client) return reject(new Error("Not connected to the runner."));
        const requestId = client.sideAsk(text, sideId);
        sideWaiters.current.set(requestId, resolve);
      }),
    [],
  );
  const login = {
    update: loginUpdate,
    start: useCallback(() => {
      setLoginUpdate({ state: "starting" });
      // The dashboard only keeps a sign-in that a member asked for; say so first.
      const t = targetRef.current;
      const asked = t.mode === "cloud" ? t.api.requestSignIn(t.thread.id).catch(() => undefined) : Promise.resolve();
      void asked.then(() => clientRef.current?.startLogin());
    }, []),
    input: useCallback((text: string) => clientRef.current?.loginInput(text), []),
    cancel: useCallback(() => {
      clientRef.current?.cancelLogin();
      setLoginUpdate(null);
    }, []),
  };
  const side = {
    chats: sideChats,
    events: sideEvents,
    ask: sideAsk,
    pin: useCallback((id: string, pinned: boolean) => clientRef.current?.sidePin(id, pinned), []),
    close: useCallback((id: string) => clientRef.current?.sideClose(id), []),
    open: useCallback((id: string) => clientRef.current?.sideOpen(id), []),
  };
  const restart = useCallback(() => setGeneration(g => g + 1), []);
  const disconnect = useCallback(() => {
    disconnectedRef.current = true;
    clientRef.current?.close();
    clientRef.current = null;
    setConnection(null);
    setState("offline");
    setError(null);
  }, []);

  return {
    events,
    pending,
    state,
    error,
    status,
    connection,
    send,
    interrupt,
    approve,
    editQueued,
    rewind,
    compact,
    options,
    setOptions,
    answerQuestion,
    limitAction,
    login,
    side,
    restart,
    disconnect,
  };
}

function newClientMsgId(): string {
  return globalThis.crypto.randomUUID();
}

/** Where a thread's runner is (starting it, for a local thread); null while a cloud one is paused or booting. */
export async function resolveConnection(target: SessionTarget): Promise<Connection | null> {
  if (target.mode === "local") {
    const { meta, runnerPath } = target;
    // On this computer, or on another machine through an SSH tunnel: the same from here on.
    const info = await startThreadRunner(meta, runnerPath);
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
