import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Cloud,
  Ellipsis,
  ExternalLink,
  FileDiff,
  GitBranch,
  Laptop,
  PanelRight,
  Pause,
  Play,
  Power,
  RotateCw,
  Shrink,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import type { PolicyDenied, ThreadStatus } from "@lemonlime/protocol";
import { buildTimeline } from "../lib/timeline.ts";
import { useThreadSession, type SessionState, type SessionTarget } from "../lib/useThreadSession.ts";
import type { ThreadEntry } from "../lib/threads.ts";
import { summarize } from "../lib/threads.ts";
import { AGENT_LABELS, STATUS_LABELS, repoName } from "../lib/format.ts";
import { CloudError, type CloudApi } from "../lib/cloud.ts";
import { confirmAction } from "../lib/native.ts";
import { Timeline } from "./Timeline.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { DiffView } from "./DiffView.tsx";
import { Menu, MenuItem, Tip } from "./primitives.tsx";
import { Button, StatusDot, cx, openExternal } from "./ui.tsx";

export interface ThreadViewProps {
  entry: ThreadEntry;
  runnerUp: boolean;
  runnerPath: string;
  cloudApi: CloudApi | null;
  onLocalProgress: (id: string, lastSeq: number) => void;
  onLocalStatus: (id: string, status: ThreadStatus) => void;
  onLocalPromptSent: (id: string) => void;
  onStopLocal: (id: string) => Promise<void>;
  onRemoveLocal: (id: string) => void;
  onCloudRefresh: () => void;
  onRunnersChanged: () => void;
}

export function ThreadView(props: ThreadViewProps) {
  const { entry, cloudApi } = props;
  if (entry.mode === "cloud" && !cloudApi) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-center text-ink-soft">
        Add your control plane URL and access token in Settings to open cloud threads.
      </div>
    );
  }
  const target: SessionTarget =
    entry.mode === "local" ? { mode: "local", meta: entry.meta, runnerPath: props.runnerPath } : { mode: "cloud", thread: entry.thread, api: cloudApi! };
  return <ThreadSessionView {...props} target={target} />;
}

function ThreadSessionView({
  entry,
  target,
  runnerUp,
  cloudApi,
  onLocalProgress,
  onLocalStatus,
  onLocalPromptSent,
  onStopLocal,
  onRemoveLocal,
  onCloudRefresh,
  onRunnersChanged,
}: ThreadViewProps & { target: SessionTarget }) {
  const session = useThreadSession(target, {
    onProgress: entry.mode === "local" ? onLocalProgress : undefined,
    onStatus: entry.mode === "local" ? onLocalStatus : undefined,
    onPromptSent: onLocalPromptSent,
  });
  const summary = summarize(entry, runnerUp);
  const items = useMemo(() => buildTimeline(session.events, session.pending), [session.events, session.pending]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [denial, setDenial] = useState<PolicyDenied | null>(null);

  const connected = session.state === "live" || session.state === "reconnecting";
  // While connected the runner is the source of truth; otherwise the control plane (cloud) is.
  const liveStatus: ThreadStatus | null = entry.mode === "cloud" ? (connected ? (session.status ?? entry.thread.status) : entry.thread.status) : session.status;
  const working = liveStatus === "running" && connected;
  // A paused cloud thread still takes messages: sending one saves it and wakes the sandbox.
  const pausedCloud = entry.mode === "cloud" && entry.thread.status === "paused" && session.state === "offline";
  const composerDisabled = !pausedCloud && (session.state === "starting" || session.state === "offline" || session.state === "error");

  // Once a local runner has been started, refresh the "running" set in the sidebar.
  useEffect(() => {
    if (entry.mode === "local" && session.state === "connecting") onRunnersChanged();
  }, [entry.mode, session.state, onRunnersChanged]);

  // A cloud sandbox that is still starting has no endpoint yet: check again shortly.
  const cloudStatus = entry.mode === "cloud" ? entry.thread.status : null;
  const { state: sessionState, restart: restartSession } = session;
  useEffect(() => {
    if (sessionState !== "offline" || cloudStatus !== "provisioning") return;
    const t = setTimeout(() => {
      onCloudRefresh();
      restartSession();
    }, 3000);
    return () => clearTimeout(t);
  }, [sessionState, cloudStatus, onCloudRefresh, restartSession]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    setDenial(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof CloudError && err.denial) setDenial(err.denial);
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stopLocal = () =>
    run(async () => {
      session.disconnect();
      await onStopLocal(summary.id);
      onRunnersChanged();
    });

  const pauseCloud = () =>
    run(async () => {
      await cloudApi!.pauseThread(summary.id);
      onCloudRefresh();
      session.restart();
    });

  const resumeCloud = () =>
    run(async () => {
      await cloudApi!.resumeThread(summary.id);
      onCloudRefresh();
      session.restart();
    });

  const removeLocal = async () => {
    const ok = await confirmAction(
      `Remove “${summary.title}” from LemonLime? The runner is stopped and the history cached in this app is cleared. Your repository and the ${summary.branch} branch are not touched.`,
    );
    if (ok) onRemoveLocal(summary.id);
  };

  // While the computer is offline, a quiet pill says so instead of error cards.
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  const errorText = online ? (actionError ?? session.error) : null;
  const [panelOpen, setPanelOpen] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const rewindTo = async (seq: number, text: string, restoreFiles: boolean) => {
    const ok = await confirmAction(
      restoreFiles
        ? "Go back to this message and put the files back to how they were then? The agent stops, starts a fresh conversation with a recap, and later changes are set aside (git keeps them under refs/lemonlime/rewind)."
        : "Go back to this message? The agent stops and starts a fresh conversation with a recap. Files stay as they are now.",
    );
    if (!ok) return;
    session.rewind(seq, restoreFiles);
    composerRef.current?.fill(text);
  };
  const [panelTab, setPanelTab] = useState<"changes" | "terminal">("changes");

  return (
    <div className="flex min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={`Thread ${summary.title}`}>
        <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5">
          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5">
            <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold tracking-normal text-ink">{summary.title}</h1>
            <span className="hidden min-w-0 items-center gap-1.5 truncate text-[13.5px] text-ink-faint md:inline-flex" title={summary.repo}>
              {summary.mode === "local" ? (
                <Laptop aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{repoName(summary.repo)}</span>
            </span>
          </div>
          {!online ? (
            <span
              role="status"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-cream-deep px-2.5 text-[12.5px] font-medium text-ink-soft"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-control" />
              Offline
            </span>
          ) : (
            <ConnectionBadge state={session.state} status={liveStatus} />
          )}
          {entry.mode === "local" ? (
            session.state === "offline" || session.state === "error" ? (
              <Button size="sm" variant="ghost" onClick={session.restart} disabled={busy}>
                <Play aria-hidden="true" className="size-3.5" />
                Start
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={stopLocal} disabled={busy || session.state === "starting"}>
                <Power aria-hidden="true" className="size-3.5" />
                Stop
              </Button>
            )
          ) : cloudStatus === "paused" || cloudStatus === "stopped" ? (
            <Button size="sm" variant="ghost" onClick={resumeCloud} disabled={busy}>
              <Play aria-hidden="true" className="size-3.5" />
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={pauseCloud} disabled={busy || cloudStatus === "provisioning" || cloudStatus === "failed"}>
              <Pause aria-hidden="true" className="size-3.5" />
              Pause
            </Button>
          )}
          {(entry.mode === "local" || summary.agent.kind === "claude-code") && (
            <Menu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label="Thread options"
                  className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep data-[popup-open]:bg-cream-deep"
                >
                  <Ellipsis aria-hidden="true" className="size-4" />
                </button>
              }
            >
              {summary.agent.kind === "claude-code" && (
                <MenuItem icon={<Shrink />} disabled={session.state !== "live" || working} onSelect={session.compact}>
                  Compact conversation
                </MenuItem>
              )}
              {entry.mode === "local" && (
                <MenuItem icon={<Trash2 />} onSelect={() => void removeLocal()}>
                  Remove thread
                </MenuItem>
              )}
            </Menu>
          )}
          <Tip label={panelOpen ? "Hide panel" : "Show changes and terminal"} side="bottom">
            <button
              type="button"
              aria-label={panelOpen ? "Hide panel" : "Show changes and terminal"}
              aria-pressed={panelOpen}
              onClick={() => setPanelOpen(o => !o)}
              className={cx(
                "inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep",
                panelOpen && "bg-cream-deep text-ink",
              )}
            >
              <PanelRight aria-hidden="true" className="size-4" />
            </button>
          </Tip>
        </header>

        {denial && (
          <div className="flex items-center gap-3 border-b border-[#f0d95c] bg-lemon-soft px-6 py-2.5 text-[13.5px] text-ink" role="alert">
            <p className="min-w-0 flex-1">{denial.reason}</p>
            {denial.actionUrl && (
              <Button size="sm" variant="secondary" onClick={() => void openExternal(denial.actionUrl!)}>
                {denial.actionLabel || "Learn more"}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </Button>
            )}
          </div>
        )}

        {errorText && (
          <div className="flex items-center gap-3 border-b border-danger/20 bg-danger-soft px-6 py-2.5 text-[13.5px]" role="alert">
            <p className="min-w-0 flex-1 text-ink">{errorText}</p>
            {(session.state === "error" || session.state === "offline") && (
              <Button size="sm" variant="secondary" onClick={session.restart}>
                <RotateCw aria-hidden="true" className="size-3.5" />
                Try again
              </Button>
            )}
          </div>
        )}

        <Timeline
          items={items}
          working={working && items[items.length - 1]?.kind !== "agent"}
          empty={<EmptyThread state={session.state} mode={summary.mode} branch={summary.branch} cloudStatus={cloudStatus} />}
          onApprove={session.approve}
          onEditQueued={session.editQueued}
          onRewind={rewindTo}
        />

        <div className="shrink-0 px-6 pt-2 pb-5">
          <div className="mx-auto max-w-[760px]">
            <Composer
              ref={composerRef}
              onSend={session.send}
              onInterrupt={session.interrupt}
              working={working}
              disabled={composerDisabled}
              tools={
                <span className="flex min-w-0 items-center gap-3 px-2 text-[13.5px] text-ink-soft">
                  <span className="inline-flex items-center gap-1.5">
                    <Bot aria-hidden="true" className="size-4" />
                    {AGENT_LABELS[summary.agent.kind]}
                    {summary.agent.model ? <span className="text-ink-faint">{summary.agent.model}</span> : null}
                  </span>
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[12.5px]">
                    <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-leaf" />
                    <span className="truncate">{summary.branch}</span>
                  </span>
                </span>
              }
              disabledReason={
                session.state === "starting"
                  ? summary.mode === "local"
                    ? "Starting the runner…"
                    : "Connecting…"
                  : summary.mode === "cloud" && cloudStatus === "paused"
                    ? "This sandbox is paused. Send a message to wake it."
                    : "Not connected"
              }
            />
          </div>
        </div>
      </section>
      {panelOpen && <SidePanel tab={panelTab} onTab={setPanelTab} session={session} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}

/** The right panel: the files the agent changed, and the thread's terminal. */
function SidePanel({
  tab,
  onTab,
  session,
  onClose,
}: {
  tab: "changes" | "terminal";
  onTab: (t: "changes" | "terminal") => void;
  session: ReturnType<typeof useThreadSession>;
  onClose: () => void;
}) {
  const changed = useMemo(() => new Set(session.events.filter(e => e.type === "file_diff").map(e => (e as { path: string }).path)).size, [session.events]);
  // Mounted once opened, so switching tabs doesn't drop the terminal's screen.
  const [terminalSeen, setTerminalSeen] = useState(tab === "terminal");
  useEffect(() => {
    if (tab === "terminal") setTerminalSeen(true);
  }, [tab]);
  const tabClass = (on: boolean) =>
    cx(
      "inline-flex h-[30px] items-center gap-2 rounded-lg px-2.5 text-[14px] font-medium",
      on ? "bg-cream-deep text-ink" : "text-ink-soft hover:bg-cream-deep/60 hover:text-ink",
    );
  return (
    <aside aria-label="Thread panel" className="flex w-[440px] shrink-0 flex-col border-l border-line bg-cream">
      <div role="tablist" aria-label="Panel" className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-3">
        <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => onTab("changes")} className={tabClass(tab === "changes")}>
          <FileDiff aria-hidden="true" className="size-3.5" />
          Changes
          {changed > 0 && <span className="text-ink-faint tabular-nums">{changed}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => onTab("terminal")} className={tabClass(tab === "terminal")}>
          <SquareTerminal aria-hidden="true" className="size-3.5" />
          Terminal
        </button>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {tab === "changes" && <ChangesList events={session.events} />}
      {terminalSeen && (
        <div className={cx("min-h-0 flex-1 flex-col", tab === "terminal" ? "flex" : "hidden")}>
          <TerminalPanel connection={session.connection} />
        </div>
      )}
    </aside>
  );
}

/** Every file the agent changed in this thread, latest diff first. */
function ChangesList({ events }: { events: ReturnType<typeof useThreadSession>["events"] }) {
  const files = useMemo(() => {
    const latest = new Map<string, Extract<(typeof events)[number], { type: "file_diff" }>>();
    for (const e of events) if (e.type === "file_diff") latest.set(e.path, e);
    return [...latest.values()].reverse();
  }, [events]);
  const [open, setOpen] = useState<string | null>(null);
  const shown = files.find(f => f.path === open);
  return (
    <div role="tabpanel" aria-label="Changes" className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
            Files the agent changes show up here after each turn.
          </p>
        ) : shown ? (
          <div>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="mb-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13.5px] text-ink-soft hover:bg-cream-deep"
            >
              ← All files
            </button>
            <DiffView path={shown.path} change={shown.change} diff={shown.diff} truncated={shown.truncated} />
          </div>
        ) : (
          <ul className="flex flex-col gap-px">
            {files.map(f => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setOpen(f.path)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-cream-deep"
                >
                  <span
                    className={cx("size-1.5 shrink-0 rounded-full", f.change === "added" ? "bg-lime-2" : f.change === "deleted" ? "bg-danger" : "bg-lemon-2")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{f.path}</span>
                  <span className="shrink-0 text-[12.5px] text-ink-faint">{f.change}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyThread({ state, mode, branch, cloudStatus }: { state: SessionState; mode: "local" | "cloud"; branch: string; cloudStatus: ThreadStatus | null }) {
  let heading = "Tell the agent what to work on";
  let body = (
    <>
      Everything it changes lands on <span className="font-mono text-[12.5px] text-ink">{branch}</span>, so your other branches stay as they are.
    </>
  );
  if (state === "starting") {
    heading = mode === "local" ? "Starting the runner" : "Connecting";
    body = <>This takes a moment the first time.</>;
  } else if (state === "offline" && cloudStatus === "provisioning") {
    heading = "Starting the sandbox";
    body = <>The thread opens as soon as its sandbox is ready.</>;
  } else if (state === "offline" && cloudStatus === "paused") {
    heading = "This sandbox is paused";
    body = <>Resume it to pick up where the agent left off.</>;
  }
  return (
    <div className="mx-auto mt-[12vh] flex max-w-md flex-col items-center text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-line bg-white shadow-panel">
        <GitBranch aria-hidden="true" className="size-5 text-leaf" />
      </div>
      <h2 className="text-lg font-semibold text-ink">{heading}</h2>
      <p className="mt-1.5 text-[13.5px] text-ink-soft">{body}</p>
    </div>
  );
}

const STATE_LABEL: Record<SessionState, string> = {
  starting: "Starting",
  connecting: "Connecting",
  live: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  error: "Not connected",
};

function ConnectionBadge({ state, status }: { state: SessionState; status: ThreadStatus | null }) {
  const offlineStatus = state === "offline" && (status === "paused" || status === "provisioning" || status === "failed");
  const label = (state === "live" || offlineStatus) && status ? STATUS_LABELS[status] : STATE_LABEL[state];
  const dot =
    state === "live" ? (
      <StatusDot status={status ?? "idle"} />
    ) : state === "error" ? (
      <StatusDot status="failed" />
    ) : state === "offline" ? (
      <StatusDot status="offline" />
    ) : (
      <span className="inline-block size-2 animate-pulse-soft rounded-full bg-lemon" aria-hidden="true" />
    );
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[13px]",
        state === "error" ? "border-danger/25 bg-danger-soft text-danger" : "border-line bg-white text-ink-soft",
      )}
      role="status"
      aria-live="polite"
      title={`Connection: ${STATE_LABEL[state]}`}
    >
      {dot}
      {label}
    </span>
  );
}
