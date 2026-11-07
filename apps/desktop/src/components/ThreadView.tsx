import { useEffect, useMemo, useState } from "react";
import { Cloud, ExternalLink, GitBranch, Laptop, Pause, Play, Power, RotateCw, Trash2 } from "lucide-react";
import type { PolicyDenied, ThreadStatus } from "@lemonlime/protocol";
import { buildTimeline } from "../lib/timeline.ts";
import { useThreadSession, type SessionState, type SessionTarget } from "../lib/useThreadSession.ts";
import type { ThreadEntry } from "../lib/threads.ts";
import { summarize } from "../lib/threads.ts";
import { AGENT_LABELS, STATUS_LABELS, repoName } from "../lib/format.ts";
import { CloudError, type CloudApi } from "../lib/cloud.ts";
import { confirmAction } from "../lib/native.ts";
import { Timeline } from "./Timeline.tsx";
import { Composer } from "./Composer.tsx";
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
    entry.mode === "local"
      ? { mode: "local", meta: entry.meta, runnerPath: props.runnerPath }
      : { mode: "cloud", thread: entry.thread, api: cloudApi! };
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
  const liveStatus: ThreadStatus | null =
    entry.mode === "cloud" ? (connected ? (session.status ?? entry.thread.status) : entry.thread.status) : session.status;
  const working = liveStatus === "running" && connected;
  const composerDisabled = session.state === "starting" || session.state === "offline" || session.state === "error";

  // Once a local runner has been started, refresh the "running" set in the sidebar.
  useEffect(() => {
    if (entry.mode === "local" && session.state === "connecting") onRunnersChanged();
  }, [entry.mode, session.state, onRunnersChanged]);

  // A cloud sandbox that is still starting has no endpoint yet: check again shortly.
  const cloudStatus = entry.mode === "cloud" ? entry.thread.status : null;
  useEffect(() => {
    if (session.state !== "offline" || cloudStatus !== "provisioning") return;
    const t = setTimeout(() => {
      onCloudRefresh();
      session.restart();
    }, 3000);
    return () => clearTimeout(t);
  }, [session.state, cloudStatus, onCloudRefresh, session.restart]);

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

  const errorText = actionError ?? session.error;

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Thread ${summary.title}`}>
      <header className="flex items-start gap-4 border-b border-line bg-white/70 px-6 py-3.5 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[19px] font-semibold text-ink">{summary.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              {summary.mode === "local" ? (
                <Laptop aria-hidden="true" className="size-3.5" />
              ) : (
                <Cloud aria-hidden="true" className="size-3.5" />
              )}
              {summary.mode === "local" ? "This computer" : "Cloud"}
            </span>
            <span>{AGENT_LABELS[summary.agent.kind]}{summary.agent.model ? ` · ${summary.agent.model}` : ""}</span>
            <span className="truncate" title={summary.repo}>
              {repoName(summary.repo)}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-cream-deep px-1.5 py-0.5 font-mono text-[12px] text-ink">
              <GitBranch aria-hidden="true" className="size-3 text-leaf" />
              {summary.branch}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <ConnectionBadge state={session.state} status={liveStatus} />
          {entry.mode === "local" ? (
            <>
              {session.state === "offline" || session.state === "error" ? (
                <Button size="sm" onClick={session.restart} disabled={busy}>
                  <Play aria-hidden="true" className="size-3.5" />
                  Start runner
                </Button>
              ) : (
                <Button size="sm" onClick={stopLocal} disabled={busy || session.state === "starting"}>
                  <Power aria-hidden="true" className="size-3.5" />
                  Stop runner
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={removeLocal} aria-label="Remove thread" title="Remove thread">
                <Trash2 aria-hidden="true" className="size-3.5" />
              </Button>
            </>
          ) : cloudStatus === "paused" || cloudStatus === "stopped" ? (
            <Button size="sm" onClick={resumeCloud} disabled={busy}>
              <Play aria-hidden="true" className="size-3.5" />
              Resume
            </Button>
          ) : (
            <Button size="sm" onClick={pauseCloud} disabled={busy || cloudStatus === "provisioning" || cloudStatus === "failed"}>
              <Pause aria-hidden="true" className="size-3.5" />
              Pause
            </Button>
          )}
        </div>
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
      />

      <Composer
        onSend={session.send}
        onInterrupt={session.interrupt}
        working={working}
        disabled={composerDisabled}
        disabledReason={
          session.state === "starting"
            ? summary.mode === "local"
              ? "Starting the runner…"
              : "Connecting…"
            : summary.mode === "cloud" && cloudStatus === "paused"
              ? "This sandbox is paused. Resume it to continue."
              : "Not connected"
        }
      />
    </section>
  );
}

function EmptyThread({
  state,
  mode,
  branch,
  cloudStatus,
}: {
  state: SessionState;
  mode: "local" | "cloud";
  branch: string;
  cloudStatus: ThreadStatus | null;
}) {
  let heading = "Tell the agent what to work on";
  let body = (
    <>
      Everything it changes lands on <span className="font-mono text-[12.5px] text-ink">{branch}</span>, so your other branches stay
      as they are.
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
