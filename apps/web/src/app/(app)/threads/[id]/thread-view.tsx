"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { RunnerClient, type ConnectionState } from "@lemonlime/client";
import type { PolicyDenied, Thread, ThreadEvent } from "@lemonlime/protocol";
import { DeniedNotice } from "@/components/denied-notice.tsx";
import { AGENT_LABELS, StatusPill, repoName } from "@/components/status-pill.tsx";
import { apiFetch } from "@/lib/api-client.ts";
import type { ThreadResponse } from "@/lib/threads.ts";
import { addEvent, buildTimeline, type PendingMessage } from "@/lib/timeline.ts";
import { Timeline } from "./timeline.tsx";

type Conn = ConnectionState | "offline";

const CONN_LABEL: Record<Conn, { text: string; dot: string }> = {
  live: { text: "Live", dot: "bg-leaf" },
  connecting: { text: "Connecting", dot: "bg-[#c9a800] animate-pulse" },
  reconnecting: { text: "Reconnecting", dot: "bg-[#c9a800] animate-pulse" },
  closed: { text: "Disconnected", dot: "bg-muted" },
  offline: { text: "Not connected", dot: "bg-line" },
};

const INITIAL_PROMPT_ID = "initial-prompt";

export function ThreadView({ initial }: { initial: ThreadResponse }) {
  const router = useRouter();
  const id = initial.thread.id;
  const [thread, setThread] = useState<Thread>(initial.thread);
  const [endpointUrl, setEndpointUrl] = useState<string | null>(initial.endpoint?.url ?? null);
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [conn, setConn] = useState<Conn>(initial.endpoint ? "connecting" : "offline");
  const [runnerError, setRunnerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [denied, setDenied] = useState<PolicyDenied | null>(null);
  const [busy, setBusy] = useState<null | "pause" | "resume" | "close">(null);
  const [draft, setDraft] = useState("");

  const clientRef = useRef<RunnerClient | null>(null);
  const tokenRef = useRef<{ token: string; expiresAt: string } | null>(
    initial.endpoint ? { token: initial.endpoint.token, expiresAt: initial.endpoint.expiresAt } : null,
  );
  const eventsRef = useRef<ThreadEvent[]>([]);
  const queuedRef = useRef<Array<{ text: string; clientMsgId: string }>>([]);
  const initialPromptHandled = useRef(!initial.initialPrompt);

  const isCloud = thread.mode === "cloud";
  const isRunning = thread.status === "running";
  const canResume = isCloud && (thread.status === "paused" || thread.status === "failed") && !endpointUrl;
  const canPause = isCloud && !!endpointUrl;
  const closed = thread.status === "stopped";

  const apply = useCallback((data: ThreadResponse) => {
    setThread(data.thread);
    if (data.endpoint) tokenRef.current = { token: data.endpoint.token, expiresAt: data.endpoint.expiresAt };
    setEndpointUrl(data.endpoint?.url ?? null);
  }, []);

  const refresh = useCallback(async (): Promise<ThreadResponse | null> => {
    const res = await apiFetch<ThreadResponse>(`/api/threads/${id}`);
    if (!res.ok) return null;
    apply(res.data);
    return res.data;
  }, [id, apply]);

  // One live connection per runner URL. Events survive reconnects and resumes.
  useEffect(() => {
    if (!endpointUrl) {
      setConn("offline");
      return;
    }
    const client = new RunnerClient({
      url: endpointUrl,
      resumeFrom: eventsRef.current.at(-1)?.seq ?? 0,
      token: async () => {
        const cached = tokenRef.current;
        tokenRef.current = null;
        if (cached && Date.parse(cached.expiresAt) - Date.now() > 60_000) return cached.token;
        const data = await refresh();
        tokenRef.current = null;
        if (!data?.endpoint) throw new Error("the sandbox is not running");
        return data.endpoint.token;
      },
      onEvent: event => {
        eventsRef.current = addEvent(eventsRef.current, event);
        setEvents(eventsRef.current);
        if (event.type === "status_change") setThread(t => ({ ...t, status: event.to }));
      },
      onWelcome: runnerThread => setThread(t => ({ ...t, status: runnerThread.status })),
      onState: state => {
        setConn(state);
        if (state !== "live") return;
        setRunnerError(null);
        // Deliver the thread's first message once, unless someone already started the conversation.
        if (!initialPromptHandled.current) {
          initialPromptHandled.current = true;
          const hasUserMessage = eventsRef.current.some(e => e.type === "user_message");
          if (!hasUserMessage && initial.initialPrompt) {
            setPending(p => [...p, { clientMsgId: INITIAL_PROMPT_ID, text: initial.initialPrompt!, at: new Date().toISOString() }]);
            client.send(initial.initialPrompt, INITIAL_PROMPT_ID);
          }
        }
      },
      onError: message => setRunnerError(message),
    });
    clientRef.current = client;
    for (const m of queuedRef.current.splice(0)) client.send(m.text, m.clientMsgId);
    client.connect();
    return () => {
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [endpointUrl, refresh, initial.initialPrompt]);

  // While not connected, poll so a resume from another device or an automatic pause shows up.
  useEffect(() => {
    if (endpointUrl || !isCloud || closed) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [endpointUrl, isCloud, closed, refresh]);

  const resume = useCallback(async () => {
    setBusy("resume");
    setActionError(null);
    setDenied(null);
    const res = await apiFetch<ThreadResponse>(`/api/threads/${id}/resume`, { method: "POST" });
    setBusy(null);
    if (res.ok) apply(res.data);
    else if (res.denied) setDenied(res.denied);
    else setActionError(res.message);
  }, [id, apply]);

  async function pause() {
    setBusy("pause");
    setActionError(null);
    const res = await apiFetch<ThreadResponse>(`/api/threads/${id}/pause`, { method: "POST" });
    setBusy(null);
    if (res.ok) apply(res.data);
    else setActionError(res.message);
  }

  async function closeThread() {
    const message = isCloud
      ? "Close this thread and delete its sandbox? Work that was not pushed from the sandbox is lost."
      : "Close this thread?";
    if (!window.confirm(message)) return;
    setBusy("close");
    const res = await apiFetch<ThreadResponse>(`/api/threads/${id}`, { method: "DELETE" });
    setBusy(null);
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else setActionError(res.message);
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const clientMsgId = crypto.randomUUID();
    setPending(p => [...p, { clientMsgId, text, at: new Date().toISOString() }]);
    setDraft("");
    if (clientRef.current) clientRef.current.send(text, clientMsgId);
    else {
      queuedRef.current.push({ text, clientMsgId });
      if (canResume) void resume();
    }
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  const items = useMemo(() => buildTimeline(events, pending), [events, pending]);

  // Follow new output while the reader is at the bottom.
  const bottomRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      atBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (atBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const connLabel = CONN_LABEL[conn];

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-3xl flex-col px-5">
      <header className="border-b border-line py-6">
        <Link href="/" className="text-sm text-muted hover:text-ink">Threads</Link>
        <div className="mt-2 flex flex-wrap items-start gap-3">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold leading-tight">{thread.title || "Untitled thread"}</h1>
          <StatusPill status={thread.status} />
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span>{AGENT_LABELS[thread.agent.kind] ?? thread.agent.kind}{thread.agent.model ? ` · ${thread.agent.model}` : ""}</span>
          <span aria-hidden>·</span>
          <span>{repoName(thread.repo.url)}</span>
          <span aria-hidden>·</span>
          <span className="font-mono text-[0.8125rem] text-ink">{thread.branch}</span>
          <span aria-hidden>·</span>
          <span>{isCloud ? `Cloud, ${thread.sandboxSize}` : "This computer"}</span>
        </p>

        {isCloud && !closed && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-auto inline-flex items-center gap-2 text-sm text-muted" aria-live="polite">
              <span aria-hidden className={`h-2 w-2 rounded-full ${connLabel.dot}`} />
              {thread.status === "provisioning" && conn !== "live" ? "Starting sandbox" : connLabel.text}
            </span>
            {isRunning && conn === "live" && (
              <button type="button" className="btn-ghost h-8" onClick={() => clientRef.current?.interrupt()}>
                Interrupt
              </button>
            )}
            {canPause && (
              <button type="button" className="btn-ghost h-8" onClick={pause} disabled={busy !== null}>
                {busy === "pause" ? "Pausing..." : "Pause"}
              </button>
            )}
            {canResume && (
              <button type="button" className="btn-lemon h-8" onClick={resume} disabled={busy !== null}>
                {busy === "resume" ? "Resuming..." : "Resume"}
              </button>
            )}
            <button type="button" className="btn-danger h-8" onClick={closeThread} disabled={busy !== null}>
              {busy === "close" ? "Closing..." : "Close thread"}
            </button>
          </div>
        )}

        <div className="mt-4 space-y-2 empty:hidden">
          {denied && <DeniedNotice denied={denied} onDismiss={() => setDenied(null)} />}
          {actionError && <Banner tone="error">{actionError}</Banner>}
          {runnerError && conn !== "live" && <Banner tone="muted">Runner: {runnerError}</Banner>}
        </div>
      </header>

      {!isCloud ? (
        <section className="card my-8 p-6">
          <h2 className="text-lg font-semibold">This thread runs on your computer</h2>
          <p className="mt-1 text-sm text-muted">
            Open it in the LemonLime desktop app to watch and talk to the agent. The desktop app runs the runner locally
            and keeps the history on your machine.
          </p>
        </section>
      ) : (
        <>
          <section aria-label="Thread history" className="flex-1 py-6">
            {items.length === 0 ? (
              <EmptyState status={thread.status} connected={conn === "live"} />
            ) : (
              <Timeline items={items} />
            )}
            <div ref={bottomRef} />
          </section>

          {!closed && (
            <form onSubmit={send} className="sticky bottom-0 -mx-5 border-t border-line bg-cream/95 px-5 pb-5 pt-3 backdrop-blur">
              <label htmlFor="composer" className="sr-only">Message the agent</label>
              <div className="flex items-end gap-2 rounded-xl border border-control bg-paper p-2 transition-[border-color,box-shadow] duration-150 focus-within:border-leaf focus-within:shadow-[0_0_0_1px_var(--color-leaf)]">
                <textarea
                  id="composer"
                  rows={1}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={onComposerKey}
                  placeholder={canResume ? "Message the agent to resume the sandbox" : "Message the agent"}
                  className="max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed outline-none placeholder:text-muted/70 [field-sizing:content]"
                />
                <button type="submit" className="btn-primary" disabled={!draft.trim() || busy === "resume"}>
                  {canResume ? "Resume and send" : "Send"}
                </button>
              </div>
              <p className="mt-1.5 px-1 text-xs text-muted">Enter to send, Shift+Enter for a new line.</p>
            </form>
          )}
        </>
      )}
    </main>
  );
}

function Banner({ tone, children }: { tone: "error" | "muted"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          : "rounded-lg border border-line bg-paper px-3 py-2 text-sm text-muted"
      }
    >
      {children}
    </p>
  );
}

function EmptyState({ status, connected }: { status: Thread["status"]; connected: boolean }) {
  const text =
    status === "provisioning"
      ? "The sandbox is starting. The agent's work shows up here as it happens."
      : status === "paused"
        ? "The sandbox is paused. Resume it to load the history and keep going."
        : status === "stopped"
          ? "This thread is closed."
          : connected
            ? "Nothing here yet. Send the agent a message to get started."
            : "Connecting to the runner...";
  return <p className="py-16 text-center text-sm text-muted">{text}</p>;
}
