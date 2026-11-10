import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Ellipsis, Eye } from "lucide-react";
import type { ChildWork, Thread } from "@lemonlime/protocol";
import type { CloudApi } from "../lib/cloud.ts";
import { repoName } from "../lib/format.ts";
import { useStableRows, useStableValue } from "../lib/stable.ts";
import { latestSubagents } from "../lib/steps.ts";
import { READ_ONLY_NOTE, statusLabel } from "../lib/threadAccess.ts";
import { summarize } from "../lib/threads.ts";
import { buildTimeline, withoutQueued } from "../lib/timeline.ts";
import { useStoredThread } from "../lib/useStoredThread.ts";
import { FindBar } from "./FindBar.tsx";
import { HistorySkeleton } from "./HistorySkeleton.tsx";
import { PaneHeader, type PaneControls } from "./SplitView.tsx";
import { ThreadMenu, type AppThreadMenu } from "./ThreadMenu.tsx";
import { Timeline } from "./Timeline.tsx";
import { StatusDot, cx } from "./ui.tsx";

/**
 * A cloud thread someone else in the workspace started and hasn't shared. The conversation
 * comes from what the control plane has stored, and nothing here reaches the thread's
 * sandbox: no message box, no answers to the agent, no terminal or files, no pause or resume.
 */
export function ReadOnlyThread({
  thread,
  api,
  threadMenu,
  paneControls,
  active = true,
  foldFinished = false,
  unreadAfterSeq,
  onWaiting,
  onChildren,
}: {
  thread: Thread;
  api: CloudApi;
  threadMenu?: AppThreadMenu | undefined;
  paneControls?: PaneControls | undefined;
  active?: boolean | undefined;
  foldFinished?: boolean | undefined;
  unreadAfterSeq?: number | null | undefined;
  onWaiting?: ((threadId: string, count: number) => void) | undefined;
  onChildren?: ((threadId: string, children: ChildWork[]) => void) | undefined;
}) {
  const { events, loading } = useStoredThread(thread, api);
  const summary = summarize({ mode: "cloud", thread }, true);
  const items = useStableRows(useMemo(() => withoutQueued(buildTimeline(events)), [events]));
  const subagents = useStableValue(useMemo(() => latestSubagents(events), [events]));
  // Where the divider goes is decided when the thread opens; reading it marks it seen.
  const [unreadAt] = useState(unreadAfterSeq ?? null);

  // Nothing in a thread someone else directs waits for this person.
  useEffect(() => {
    onWaiting?.(thread.id, 0);
    onChildren?.(thread.id, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  const activeRef = useRef(active);
  activeRef.current = active;
  const timelineRef = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState<number | null>(null);
  useEffect(() => {
    const open = () => activeRef.current && setFind(n => (n ?? 0) + 1);
    window.addEventListener("lemonlime:find", open);
    return () => window.removeEventListener("lemonlime:find", open);
  }, []);

  const compact = paneControls !== undefined;
  const status = statusLabel(thread.status, "read-only");
  const menu = (
    <ThreadMenu
      thread={summary}
      state={{
        mode: "cloud",
        pinned: threadMenu?.pinned ?? false,
        unread: threadMenu?.unread ?? false,
        archived: false,
        inSplit: threadMenu?.inSplit ?? false,
        editor: threadMenu?.editor ?? false,
      }}
      actions={threadMenu?.actions ?? {}}
      trigger={
        <button
          type="button"
          aria-label="Thread options"
          className={cx(
            "inline-flex items-center justify-center text-ink-soft hover:bg-cream-deep data-[popup-open]:bg-cream-deep",
            compact ? "size-7 shrink-0 rounded-md" : "size-8 rounded-lg",
          )}
        >
          <Ellipsis aria-hidden="true" className={compact ? "size-3.5" : "size-4"} />
        </button>
      }
    />
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`Thread ${summary.title}`}>
      {paneControls ? (
        <PaneHeader
          active={active}
          title={summary.title}
          controls={paneControls}
          glyph={
            <span role="status" aria-label={status} title={status} className="inline-flex size-4 shrink-0 items-center justify-center">
              <StatusDot status={thread.status} label={status} className="pointer-events-none" />
            </span>
          }
        >
          {menu}
        </PaneHeader>
      ) : (
        <header
          data-tauri-drag-region
          className="@container/head flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5 pl-[max(1.25rem,var(--chrome-inset,0px))]"
        >
          <div data-tauri-drag-region className="flex min-w-[120px] flex-1 items-center gap-2.5">
            <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold tracking-normal text-ink">{summary.title}</h1>
            <span
              className="hidden min-w-0 items-center gap-1.5 truncate text-[14px] text-ink-faint md:inline-flex @max-[640px]/head:hidden"
              title={summary.repo}
            >
              <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{repoName(summary.repo)}</span>
            </span>
          </div>
          <span role="status" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 text-[13px] text-ink-soft">
            <StatusDot status={thread.status} label={status} />
            <span className="@max-[640px]/head:sr-only">{status}</span>
          </span>
          {menu}
        </header>
      )}

      <div ref={timelineRef} className="relative flex min-h-0 flex-1 flex-col">
        <Timeline
          threadId={thread.id}
          reading
          foldFinished={foldFinished}
          items={items}
          working={thread.status === "running"}
          unreadAfterSeq={unreadAt}
          subagents={subagents}
          empty={loading ? <HistorySkeleton /> : <NothingStored />}
        />
        {find !== null && <FindBar root={timelineRef} version={items} focusNonce={find} onClose={() => setFind(null)} />}
      </div>

      <div className="shrink-0 px-6 pt-2 pb-5">
        <div className="mx-auto flex max-w-[760px] items-start gap-2.5 px-1 text-[14px] text-ink-soft" role="note">
          <Eye aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
          <p className="min-w-0 text-pretty">{READ_ONLY_NOTE}</p>
        </div>
      </div>
    </section>
  );
}

/** The control plane has kept nothing of the conversation yet. */
function NothingStored() {
  return (
    <div className="mx-auto mt-[12vh] flex max-w-md flex-col items-center text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-line bg-paper shadow-panel">
        <Eye aria-hidden="true" className="size-5 text-leaf" />
      </div>
      <h2 className="text-lg font-semibold text-ink">Nothing to read yet</h2>
      <p className="mt-1.5 text-[14px] text-ink-soft">The conversation shows here once the agent has started on it.</p>
    </div>
  );
}
