import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Workflow,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileDiff,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FileX,
  FolderOpen,
  GitFork,
  Globe,
  History,
  Hourglass,
  Info,
  ListChecks,
  ListTodo,
  MessageCircleQuestionMark,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Search,
  ShieldCheck,
  ShieldQuestionMark,
  ShieldX,
  SquareTerminal,
  Undo2,
  Wrench,
} from "lucide-react";
import { elapsedMs, formatDuration, type SubagentInfo, type ThreadStatus } from "@lemonlime/protocol";
import { foldFinishedTurns, type TimelineItem } from "../lib/timeline.ts";
import { collapseLongText, commandOutput, liveTurnStart, terminalTail, tocEntries, TOC_MIN_MESSAGES, unreadIndex } from "../lib/timelineView.ts";
import {
  bundleLabel,
  bundlePreview,
  bundleSteps,
  describeStep,
  isSubagentCall,
  rowGap,
  runnerSubagentId,
  subagentPrompt,
  subagentState,
  subagentTask,
  type RowGap,
  type ShownRow,
  type StepBundle,
  type StepKind,
  type SubagentState,
  type ToolItem,
} from "../lib/steps.ts";
import { parseUnifiedDiff } from "../lib/diff.ts";
import { flashItem } from "../lib/findInThread.ts";
import { StreamingMarkdown } from "../lib/markdown.tsx";
import { attachmentLabel } from "../lib/pastedText.ts";
import { loadScrollPlace, saveScrollPlace, type ScrollPlace } from "../lib/scrollMemory.ts";
import { Menu, MenuItem } from "./primitives.tsx";
import { STATUS_LABELS, clockTime, stringifyValue } from "../lib/format.ts";
import { DiffBody } from "./DiffView.tsx";
import { ActionButton, AgentMessage, MessageActions } from "./AgentMessage.tsx";
import { OptionsRow, PlanCard, QuestionRecord } from "./AgentLoop.tsx";
import { LimitRow, SwitchRow, type LimitActions } from "./LimitRow.tsx";
import { Spinner, cx } from "./ui.tsx";
import { ImageLoaderContext, SentImages, useImageLoader, type LoadImage } from "./SentImages.tsx";
import { MessageRail } from "./MessageRail.tsx";

/** Go back to the user message at `seq` (its text goes back in the composer). */
export type RewindFn = (seq: number, text: string, restoreFiles: boolean) => void;

type UserItem = Extract<TimelineItem, { kind: "user" }>;

/** What rows can do, passed down once rather than to every row by name. */
interface RowActions {
  limit?: LimitActions | undefined;
  /** The newest switch row (the one that can offer to switch other threads too). */
  lastSwitch: string | null;
  onRewind?: RewindFn | undefined;
  onImplementPlan?: (() => void) | undefined;
  onEdit?: ((item: UserItem) => void) | undefined;
  onFork?: ((key: string) => void) | undefined;
  subagents: ReadonlyMap<string, SubagentInfo>;
  /** Items from this seq on belong to the turn that is running now (null when none is). */
  liveSeq: number | null;
}

const NO_SUBAGENTS: ReadonlyMap<string, SubagentInfo> = new Map();

const GAP: Record<RowGap, string> = { none: "", step: "mt-1", block: "mt-4", turn: "mt-6" };

export function Timeline({
  items,
  working,
  empty,
  onRewind,
  onImplementPlan,
  onEdit,
  onFork,
  limit,
  foldFinished = false,
  unreadAfterSeq,
  loadImage,
  subagents = NO_SUBAGENTS,
  threadId,
}: {
  items: TimelineItem[];
  /** The thread shown, so its reading place is kept for when it's opened again. */
  threadId?: string | undefined;
  /** The last seq the user had seen when they opened the thread: a "New" divider goes after it. */
  unreadAfterSeq?: number | null | undefined;
  /** Fetches images sent with messages, while the runner can be reached. */
  loadImage?: LoadImage | null | undefined;
  /** Fold each finished turn's steps into one line (Settings → Appearance). */
  foldFinished?: boolean;
  working: boolean;
  empty: ReactNode;
  onRewind?: RewindFn | undefined;
  /** Approve the latest plan (leave plan mode and tell the agent to go ahead). */
  onImplementPlan?: (() => void) | undefined;
  /** Edit a message you sent (its text goes back in the composer). */
  onEdit?: ((item: UserItem) => void) | undefined;
  /** Start a new thread carrying the conversation up to this message. */
  onFork?: ((key: string) => void) | undefined;
  /** What the usage-limit row can do (absent while it can't act). */
  limit?: LimitActions | undefined;
  /** The runner's subagents, by id, for their rows' live status. */
  subagents?: ReadonlyMap<string, SubagentInfo> | undefined;
}) {
  const lastSwitch = useMemo(() => items.findLast(i => i.kind === "switch")?.key ?? null, [items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const shown = useMemo<ShownRow[]>(() => bundleSteps(foldFinished ? foldFinishedTurns(items) : items), [items, foldFinished]);
  const divider = useMemo(() => unreadIndex(shown, unreadAfterSeq), [shown, unreadAfterSeq]);
  const toc = useMemo(() => tocEntries(items), [items]);
  const turnStart = working ? liveTurnStart(items) : null;
  const liveSeq = useMemo(() => (working ? (items.findLast(i => i.kind === "user" && !i.pending)?.seq ?? 0) : null), [items, working]);
  const actions = useMemo<RowActions>(
    () => ({ limit, lastSwitch, onRewind, onImplementPlan, onEdit, onFork, subagents, liveSeq }),
    [limit, lastSwitch, onRewind, onImplementPlan, onEdit, onFork, subagents, liveSeq],
  );

  // The scrollbar shows while the person scrolls (not while new output follows itself).
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showScrollbar = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.dataset.scrolling = "";
    if (quietTimer.current) clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(() => delete el.dataset.scrolling, 900);
  };
  useEffect(() => () => void (quietTimer.current && clearTimeout(quietTimer.current)), []);

  // ── Following new output ──
  // While the reader is at the bottom, new output and rows that grow (highlighted code,
  // images) keep the view at the bottom. Scrolling up in any way (wheel, keys, the
  // scrollbar) stops that at once; scrolling back down to the bottom starts it again.
  // Scrolls the timeline makes itself are told apart by where they land.
  const ownTop = useRef<number | null>(null);
  /** The "Latest" button's smooth scroll, which passes through many places on its way down. */
  const gliding = useRef(false);
  const toBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    ownTop.current = el.scrollTop;
  };
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const atBottom = el.scrollHeight - top - el.clientHeight < 80;
    const own = ownTop.current !== null && Math.abs(top - ownTop.current) < 2;
    if (gliding.current && atBottom) gliding.current = false;
    if (!own && !gliding.current) {
      if (atBottom) stick.current = true;
      else if (top < lastTop.current - 1) stick.current = false;
      if (!atBottom) restore.current = null;
    }
    lastTop.current = top;
    setShowJump(!atBottom);
    notePlace();
  };
  const readerScrollsUp = () => {
    const el = scrollRef.current;
    // Nothing to scroll yet: keep following.
    if (!el || el.scrollHeight <= el.clientHeight + 1) return;
    stick.current = false;
    gliding.current = false;
    restore.current = null;
  };
  const onWheel = (e: React.WheelEvent) => {
    showScrollbar();
    if (e.deltaY < 0) readerScrollsUp();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    showScrollbar();
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.matches("input, textarea, select"));
    if (!typing && (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey))) readerScrollsUp();
  };

  // Keep following new output while the user is at the bottom.
  useLayoutEffect(() => {
    if (restore.current && tryRestore()) return;
    // The row it was left at is gone (the thread went back past it): read from the bottom.
    if (items.length > 0) restore.current = null;
    if (stick.current) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, working]);

  // Rows grow after they're drawn (code highlighting, images loading): stay at the bottom.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current && !gliding.current) toBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // ── Coming back to a thread ──
  // Starts where the reader left it (unless there's something new to show), else at the bottom.
  const restore = useRef<ScrollPlace | null>(threadId && !(unreadAfterSeq != null && unreadAfterSeq >= 0) ? loadScrollPlace(threadId) : null);
  const tryRestore = () => {
    const el = scrollRef.current;
    const want = restore.current;
    if (!el || !want) return false;
    const node = el.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(want.key)}"]`);
    if (!node) return false;
    stick.current = false;
    const place = (n: HTMLElement) => {
      el.scrollTop += n.getBoundingClientRect().top - el.getBoundingClientRect().top - want.offset;
      ownTop.current = el.scrollTop;
      lastTop.current = el.scrollTop;
    };
    place(node);
    // Rows drawn lazily take their real height once in view; settle on the next frame.
    requestAnimationFrame(() => {
      if (restore.current !== want) return;
      restore.current = null;
      place(node);
      placeRef.current = want;
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
    });
    return true;
  };

  // Where the reader is, kept as they scroll and saved when the thread closes.
  const placeRef = useRef<ScrollPlace | null>(null);
  const placeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notePlace = () => {
    if (!threadId || placeTimer.current) return;
    placeTimer.current = setTimeout(() => {
      placeTimer.current = null;
      const el = scrollRef.current;
      if (!el || restore.current) return;
      placeRef.current = stick.current ? null : topRow(el);
    }, 150);
  };
  useEffect(
    () => () => {
      if (placeTimer.current) clearTimeout(placeTimer.current);
      // Still waiting to go back to the old place: keep it as it was.
      if (threadId && !restore.current) saveScrollPlace(threadId, placeRef.current);
    },
    [threadId],
  );

  // Opening a thread with something new in it starts at the "New" divider, once.
  const shownUnread = useRef(false);
  useEffect(() => {
    if (shownUnread.current || divider < 0) return;
    shownUnread.current = true;
    const el = scrollRef.current;
    const node = el?.querySelector("[data-unread-divider]");
    if (!el || !node) return;
    restore.current = null;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 48;
    ownTop.current = el.scrollTop;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    onScroll();
  }, [divider]);

  /** Scroll to an item (from the message list) and tint it for a moment. */
  const jumpTo = useCallback((key: string) => {
    const el = scrollRef.current;
    const find = () => el?.querySelector<HTMLElement>(`[data-timeline-key="${key}"]`);
    const node = find();
    if (!el || !node) return;
    const place = (n: HTMLElement) => (el.scrollTop += n.getBoundingClientRect().top - el.getBoundingClientRect().top - 24);
    place(node);
    // Items drawn lazily (content-visibility) can change height once in view; settle on the next frame.
    requestAnimationFrame(() => {
      const again = find();
      if (again) {
        place(again);
        flashItem(again);
      }
    });
  }, []);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    gliding.current = true;
    restore.current = null;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <ImageLoaderContext.Provider value={loadImage ?? null}>
      <div className="@container relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          onTouchMove={showScrollbar}
          onKeyDown={onKeyDown}
          className="scroll-quiet relative h-full overflow-y-auto"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Thread timeline"
        >
          <div ref={contentRef} className="mx-auto flex max-w-[860px] flex-col px-6 pt-6 pb-10">
            {items.length === 0 ? empty : <Rows rows={shown} actions={actions} divider={divider} lazy />}
            {working && (
              <div className="mt-4">
                <WorkingLine since={turnStart} />
              </div>
            )}
          </div>
        </div>
        {toc.you.length >= TOC_MIN_MESSAGES && <MessageRail toc={toc} scrollRef={scrollRef} onJump={jumpTo} />}
        {showJump && (
          <button
            type="button"
            onClick={jump}
            className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-paper px-3 py-1.5 text-[13px] font-medium text-ink shadow-pop hover:bg-cream"
          >
            <ArrowDown aria-hidden="true" className="size-3.5" />
            Latest
          </button>
        )}
      </div>
    </ImageLoaderContext.Provider>
  );
}

/** The row at the top of the view and how far below the top its edge sits. */
function topRow(el: HTMLElement): ScrollPlace | null {
  const top = el.getBoundingClientRect().top;
  for (const node of el.querySelectorAll<HTMLElement>("[data-timeline-key]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom > top) return { key: node.dataset.timelineKey!, offset: Math.round(r.top - top) };
  }
  return null;
}

/** Rows that are one line high, so lazily drawn ones reserve that much room. */
const ONE_LINE = new Set(["tool", "bundle", "diff", "reasoning", "approval", "options", "fold", "status"]);

/** A list of rows with the timeline's rhythm: steps close together, messages with room around them. */
function Rows({ rows, actions, divider = -1, lazy = false }: { rows: readonly ShownRow[]; actions: RowActions; divider?: number; lazy?: boolean }) {
  return (
    <>
      {rows.map((row, i) => (
        <Fragment key={row.key}>
          {i === divider && <UnreadDivider />}
          {/* Off-screen rows skip layout and paint, so long chats stay fast. */}
          <div
            data-timeline-key={row.key}
            data-flash-target
            className={cx(
              i === divider ? "mt-4" : GAP[rowGap(rows[i - 1]?.kind, row.kind)],
              lazy &&
                i < rows.length - 30 &&
                (ONE_LINE.has(row.kind)
                  ? "[contain-intrinsic-size:auto_28px] [content-visibility:auto]"
                  : "[contain-intrinsic-size:auto_96px] [content-visibility:auto]"),
            )}
          >
            <Row row={row} actions={actions} />
          </div>
        </Fragment>
      ))}
    </>
  );
}

/** "Working for 42s": how long the turn has run, from event times, ticking once a second. */
function WorkingLine({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const ms = since ? elapsedMs(since, now) : null;
  return (
    <div data-find-skip className="flex items-center gap-2.5 pl-1 text-[13px] text-ink-soft">
      <span className="flex gap-1" aria-hidden="true">
        <span className="size-1.5 animate-pulse-soft rounded-full bg-leaf" />
        <span className="size-1.5 animate-pulse-soft rounded-full bg-leaf [animation-delay:200ms]" />
        <span className="size-1.5 animate-pulse-soft rounded-full bg-leaf [animation-delay:400ms]" />
      </span>
      {ms === null ? (
        "The agent is working"
      ) : (
        <>
          {/* The ticking number is for the eye; screen readers hear it once. */}
          <span aria-hidden="true" className="tabular-nums">
            Working for {formatDuration(ms)}
          </span>
          <span className="sr-only">The agent is working</span>
        </>
      )}
    </div>
  );
}

/** Above the first thing that arrived since the user last looked at this thread. */
function UnreadDivider() {
  return (
    <div
      data-unread-divider
      data-find-skip
      role="separator"
      aria-label="New since you last looked"
      className="mt-4 flex items-center gap-3 text-xs font-medium text-leaf"
    >
      <span className="h-px flex-1 bg-leaf/35" />
      New
      <span className="h-px flex-1 bg-leaf/35" />
    </div>
  );
}

const isLive = (seq: number | null, actions: RowActions) => actions.liveSeq !== null && seq !== null && seq >= actions.liveSeq;

const Row = memo(function Row({ row, actions }: { row: ShownRow; actions: RowActions }) {
  switch (row.kind) {
    case "fold":
      return <FoldRow items={row.items} workedMs={row.workedMs} actions={actions} />;
    case "bundle":
      return <BundleRow bundle={row} live={isLive(row.items.at(-1)!.seq, actions)} actions={actions} />;
    case "user":
      return (
        <UserMessage
          item={row}
          {...(actions.onEdit && row.seq !== null && !row.pending ? { onEdit: () => actions.onEdit!(row) } : {})}
          {...(actions.onFork && row.seq !== null && !row.pending ? { onFork: () => actions.onFork!(row.key) } : {})}
          {...(actions.onRewind && row.seq !== null && !row.pending
            ? { onRewind: (restore: boolean) => actions.onRewind!(row.seq!, row.text, restore), restorable: Boolean(row.restorable) }
            : {})}
        />
      );
    case "agent":
      return (
        <AgentMessage text={row.text} streaming={row.streaming} messageKey={row.key} onFork={actions.onFork ? () => actions.onFork!(row.key) : undefined} />
      );
    case "reasoning":
      return <ReasoningRow text={row.text} streaming={row.streaming} startedAt={row.startedAt} endedAt={row.endedAt} />;
    case "tool":
      return isSubagentCall(row.name) ? (
        <SubagentRow item={row} live={isLive(row.seq, actions)} subagents={actions.subagents} />
      ) : (
        <StepRow item={row} live={isLive(row.seq, actions)} />
      );
    case "diff":
      return <DiffRow item={row} live={isLive(row.seq, actions)} />;
    case "status":
      return <StatusRow to={row.to} reason={row.reason} at={row.at} workedMs={row.workedMs} />;
    case "error":
      return <ErrorRow message={row.message} code={row.code} fatal={row.fatal} />;
    case "notice":
      return <NoticeRow message={row.untilAt ? `${row.message} ${resetsWhen(row.untilAt)}` : row.message} />;
    case "approval":
      return <ApprovalRecord item={row} />;
    case "plan":
      return <PlanCard plan={row.plan} open={row.open} onImplement={actions.onImplementPlan} />;
    case "question":
      return <QuestionRecord questions={row.questions} answers={row.answers} state={row.state} by={row.by} />;
    case "options":
      return <OptionsRow options={row.options} />;
    case "limit":
      return <LimitRow hit={row.hit} open={row.open} waiting={row.waiting} actions={actions.limit} />;
    case "switch":
      return <SwitchRow event={row.event} others={row.key === actions.lastSwitch ? actions.limit?.others : undefined} />;
  }
});

// ─── The one disclosure row ──────────────────────────────────────────────────

/**
 * Every quiet line in the timeline (a step, a bundle of steps, a file change, the agent's
 * reasoning, a finished turn) looks the same: a muted 14px icon, a line of text, a chevron
 * when it opens, and its status on the right. Opening shows the details just under it.
 */
function Disclosure({
  icon,
  label,
  detail,
  status,
  title,
  children,
  open,
  onToggle,
}: {
  icon: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  title?: string | undefined;
  /** What opening shows. Without it the row is a plain line. */
  children?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
}) {
  const bodyId = useId();
  const inner = (
    <>
      <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 items-center justify-center text-ink-faint [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 shrink truncate">{label}</span>
      {children !== undefined && (
        <ChevronRight aria-hidden="true" className={cx("size-3.5 shrink-0 text-ink-faint transition-transform duration-150", open && "rotate-90")} />
      )}
      <span className="min-w-0 flex-1 truncate text-ink-faint">{detail}</span>
      {status && <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-[12px]">{status}</span>}
    </>
  );
  const row = "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-[13px] text-ink-soft";
  if (children === undefined)
    return (
      <div className={row} title={title}>
        {inner}
      </div>
    );
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        title={title}
        className={cx(row, "hover:bg-cream-deep hover:text-ink focus-visible:-outline-offset-2")}
      >
        {inner}
      </button>
      {open && (
        <div id={bodyId} className="mt-1 mb-2 ml-[12px] border-l border-line pl-3 transition-opacity duration-200 ease-(--ease-out) starting:opacity-0">
          {children}
        </div>
      )}
    </div>
  );
}

function useToggle(initial = false): [boolean, () => void] {
  const [open, setOpen] = useState(initial);
  return [open, useCallback(() => setOpen(o => !o), [])];
}

/** A step's verb and what it acted on: "Read" quiet, "src/app.tsx" in ink. */
function StepText({ verb, target, code, detail }: { verb: string; target: string; code: boolean; detail?: string | undefined }) {
  return (
    <>
      {verb}
      {target && (
        <>
          {" "}
          <span className={code ? "font-mono text-[12px] text-ink" : "text-ink"}>{target}</span>
        </>
      )}
      {detail && <span className="text-ink-faint"> {detail}</span>}
    </>
  );
}

const STEP_ICON: Record<StepKind, ReactNode> = {
  read: <FileText />,
  edit: <FilePen />,
  write: <FilePlus />,
  command: <SquareTerminal />,
  search: <Search />,
  files: <FileSearch />,
  list: <FolderOpen />,
  fetch: <Globe />,
  web: <Globe />,
  todo: <ListTodo />,
  background: <SquareTerminal />,
  subagent: <Workflow />,
  question: <MessageCircleQuestionMark />,
  tool: <Wrench />,
};

type StepState = "running" | "failed" | "stopped" | "done";

function stepState(item: ToolItem, live: boolean): StepState {
  if (item.result?.isError) return "failed";
  if (item.result) return "done";
  return live ? "running" : "stopped";
}

/** Status on the right of a row: a spinner while it runs, a mark and a word when it failed. Success is quiet. */
function StatusMark({ state, failed }: { state: StepState | SubagentState; failed?: string }) {
  switch (state) {
    case "running":
      return (
        <>
          <Spinner className="size-3 text-leaf" />
          <span className="sr-only">Running</span>
        </>
      );
    case "waiting":
      return (
        <>
          <Hourglass aria-hidden="true" className="size-3.5 text-amber" />
          <span className="text-ink-faint">Waiting</span>
        </>
      );
    case "failed":
      return (
        <>
          <CircleAlert aria-hidden="true" className="size-3.5 text-danger" />
          <span className="font-medium text-danger">{failed ?? "Failed"}</span>
        </>
      );
    case "stopped":
      return <span className="text-ink-faint">Didn&apos;t finish</span>;
    default:
      return null;
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

/** One tool call: "Ran pnpm test", opening to the terminal block or the input and output. */
function StepRow({ item, live }: { item: ToolItem; live: boolean }) {
  const [open, toggle] = useToggle();
  const step = describeStep(item.name, item.input);
  const state = stepState(item, live);
  const command = step.kind === "command" ? (step.full ?? step.target) : null;
  return (
    <Disclosure
      icon={STEP_ICON[step.kind]}
      label={<StepText verb={state === "running" ? step.doing : step.verb} target={step.target} code={step.code} />}
      detail={step.detail}
      title={step.full}
      status={<StatusMark state={state} />}
      open={open}
      onToggle={toggle}
    >
      {command ? (
        <TerminalBlock command={command} result={item.result} />
      ) : (
        <ToolDetails input={item.input} result={item.result} running={state === "running"} />
      )}
    </Disclosure>
  );
}

/** Steps of one kind in a row: "Read 6 files", opening to each of them. */
function BundleRow({ bundle, live, actions }: { bundle: StepBundle; live: boolean; actions: RowActions }) {
  const [open, toggle] = useToggle();
  const states = bundle.items.map(i => stepState(i, isLive(i.seq, actions)));
  const running = states.includes("running");
  const failed = states.filter(s => s === "failed").length;
  const stopped = states.includes("stopped");
  return (
    <Disclosure
      icon={STEP_ICON[bundle.step]}
      label={bundleLabel(bundle, running)}
      detail={bundlePreview(bundle)}
      status={
        running ? (
          <StatusMark state="running" />
        ) : failed ? (
          <StatusMark state="failed" failed={`${failed} failed`} />
        ) : stopped && !live ? (
          <StatusMark state="stopped" />
        ) : null
      }
      open={open}
      onToggle={toggle}
    >
      <div className="flex flex-col gap-1">
        {bundle.items.map(it => (
          <StepRow key={it.key} item={it} live={isLive(it.seq, actions)} />
        ))}
      </div>
    </Disclosure>
  );
}

const SUBAGENT_WORDS: Record<SubagentState, string> = {
  running: "Working",
  waiting: "Waiting on its own subagents",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Text of a tool's output: a string, or the text blocks of an MCP-style reply. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  const blocks = Array.isArray(output)
    ? output
    : Array.isArray((output as { content?: unknown } | null)?.content)
      ? (output as { content: unknown[] }).content
      : null;
  if (blocks) {
    const texts = blocks.flatMap(b => (b && typeof (b as { text?: unknown }).text === "string" ? [(b as { text: string }).text] : []));
    if (texts.length) return texts.join("\n\n");
  }
  return stringifyValue(output);
}

/** The agent handed part of the work to a subagent: what it's doing and how far it got. */
function SubagentRow({ item, live, subagents }: { item: ToolItem; live: boolean; subagents: ReadonlyMap<string, SubagentInfo> }) {
  const [open, toggle] = useToggle();
  const runnerId = item.result && !item.result.isError ? runnerSubagentId(item.result.output) : null;
  const info = runnerId ? subagents.get(runnerId) : undefined;
  const state = subagentState(item, info, live);
  const prompt = subagentPrompt(item.input);
  const report = item.result && !runnerId ? outputText(item.result.output) : "";
  const nested = runnerId ? [...subagents.values()].filter(s => s.parentId === runnerId) : [];
  return (
    <Disclosure
      icon={<Workflow />}
      label={<StepText verb="Subagent:" target={subagentTask(item.input)} code={false} />}
      status={
        state === "running" ? (
          <>
            <Spinner className="size-3 text-leaf" />
            <span className="text-ink-faint">Working</span>
          </>
        ) : state === "done" ? (
          <>
            <Check aria-hidden="true" className="size-3.5 text-leaf" />
            <span className="text-ink-faint">Done</span>
          </>
        ) : (
          <StatusMark state={state} />
        )
      }
      open={open}
      onToggle={toggle}
    >
      <div className="flex flex-col gap-2.5 py-1 text-[13px]">
        <p className="text-ink-soft">
          {SUBAGENT_WORDS[state]}
          {info ? `, started at ${clockTime(info.startedAt)}` : ` since ${clockTime(item.at)}`}.
          {runnerId && state === "done" ? " Its reply came back to the agent as a message." : ""}
        </p>
        {prompt && <CodeBlock label="Its task" text={prompt} />}
        {nested.length > 0 && (
          <div>
            <p className="mb-1 text-[12px] font-medium text-ink-soft">Its own subagents</p>
            <ul className="flex flex-col gap-1">
              {nested.map(s => {
                const st = subagentState({ result: null }, s, live);
                return (
                  <li key={s.id}>
                    <Disclosure icon={<Workflow />} label={<span className="text-ink">{s.task.split("\n")[0]}</span>} status={<StatusMark state={st} />} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {item.result?.isError ? (
          <CodeBlock label="Error" text={outputText(item.result.output) || "(no output)"} error />
        ) : report ? (
          <div>
            <p className="mb-1 text-[12px] font-medium text-ink-soft">What it reported</p>
            <div className="rounded-lg border border-line bg-cream px-3 py-2 text-ink">
              <StreamingMarkdown text={report} className="text-[13px]" />
            </div>
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}

const CHANGE_VERB = { added: "Created", modified: "Changed", deleted: "Deleted", renamed: "Renamed" } as const;
const CHANGE_ICON = { added: <FilePlus />, modified: <FileDiff />, deleted: <FileX />, renamed: <FilePen /> } as const;
/** While its turn runs, a short diff shows opened; once the turn is over it folds to its line. */
const AUTO_OPEN_LINES = 60;

/** A file the agent changed: "Changed src/sum.js +4 −1", opening to the diff. */
function DiffRow({ item, live }: { item: Extract<TimelineItem, { kind: "diff" }>; live: boolean }) {
  const parsed = useMemo(() => parseUnifiedDiff(item.diff), [item.diff]);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (live && parsed.lines.length <= AUTO_OPEN_LINES);
  const lines = useMemo(() => parsed.lines.filter(l => l.kind !== "meta"), [parsed]);
  return (
    <Disclosure
      icon={CHANGE_ICON[item.change]}
      label={<StepText verb={CHANGE_VERB[item.change]} target={item.path} code />}
      title={item.path}
      status={
        <span className="tabular-nums">
          <span className="text-diff-add-strong">+{parsed.additions}</span> <span className="text-diff-del-strong">−{parsed.deletions}</span>
        </span>
      }
      open={open}
      onToggle={() => setChosen(!open)}
    >
      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <DiffBody lines={lines} truncated={item.truncated} />
      </div>
    </Disclosure>
  );
}

/** A finished turn's steps folded into one line ("Fold finished turns" in Settings). */
function FoldRow({ items, workedMs, actions }: { items: TimelineItem[]; workedMs?: number | undefined; actions: RowActions }) {
  const [open, toggle] = useToggle();
  const rows = useMemo(() => (open ? bundleSteps(items) : []), [open, items]);
  return (
    <Disclosure
      icon={<ListChecks />}
      label={<span className="tabular-nums">{workedMs !== undefined ? `Worked for ${formatDuration(workedMs)}` : "Worked through it"}</span>}
      detail={`${items.length} steps`}
      open={open}
      onToggle={toggle}
    >
      <div className="flex flex-col py-1">
        <Rows rows={rows} actions={actions} />
      </div>
    </Disclosure>
  );
}

/** The agent's reasoning: one quiet line ("Thought for 12s") that opens to the text. */
function ReasoningRow({ text, streaming, startedAt, endedAt }: { text: string; streaming: boolean; startedAt: string; endedAt: string }) {
  const [open, toggle] = useToggle();
  const ms = elapsedMs(startedAt, endedAt);
  const label = (
    <span className="tabular-nums">{streaming ? "Thinking" : ms !== null && ms >= 1000 ? `Thought for ${formatDuration(ms)}` : "Thought for a moment"}</span>
  );
  const status = streaming ? <StatusMark state="running" /> : null;
  // Some agents keep what they thought to themselves: just say that they did.
  if (!text.trim()) return <Disclosure icon={<Brain />} label={label} status={status} />;
  return (
    <Disclosure icon={<Brain />} label={label} status={status} open={open} onToggle={toggle}>
      <div className="py-1 text-ink-soft">
        <StreamingMarkdown text={text} className="text-[13px]" />
      </div>
    </Disclosure>
  );
}

const DECLINED_BECAUSE: Record<string, string> = {
  timeout: "nobody answered in time",
  interrupted: "the turn was stopped",
  expired: "the runner restarted before anyone answered",
};

/** An approval, in the timeline: one line. Answering it happens above the composer. */
function ApprovalRecord({ item }: { item: Extract<TimelineItem, { kind: "approval" }> }) {
  const summary = <span className="font-mono text-[12px] text-ink">{item.summary.split("\n")[0]}</span>;
  if (item.state === "waiting")
    return (
      <Disclosure
        icon={<ShieldQuestionMark />}
        label={
          <>
            Asked to use {item.tool}: {summary}
          </>
        }
        title={item.summary}
        status={<StatusMark state="waiting" />}
      />
    );
  const allowed = item.state === "allowed";
  const why = !allowed && item.by && item.by !== "user" ? DECLINED_BECAUSE[item.by] : undefined;
  return (
    <Disclosure
      icon={allowed ? <ShieldCheck /> : <ShieldX />}
      label={
        <>
          {allowed ? "Allowed" : "Not allowed"}: {summary}
        </>
      }
      detail={why ? `(${why})` : undefined}
      title={item.summary}
    />
  );
}

// ─── Messages ────────────────────────────────────────────────────────────────

function NoticeRow({ message }: { message: string }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-line bg-cream-deep/60 px-4 py-2.5 text-[14px] text-ink-soft" role="status">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
      <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
    </div>
  );
}

function UserMessage({
  item,
  onRewind,
  restorable,
  onEdit,
  onFork,
}: {
  item: UserItem;
  onRewind?: (restoreFiles: boolean) => void;
  restorable?: boolean;
  onEdit?: () => void;
  onFork?: () => void;
}) {
  const { text, at, pending, files, images } = item;
  const canShowImages = useImageLoader() !== null && Boolean(images?.length);
  // Images shown as thumbnails aren't listed again by name.
  const listed = canShowImages ? files?.filter(f => !images!.some(i => i.name === f)) : files;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="group/msg flex animate-rise justify-end">
      <div className="max-w-[78%]">
        <div className={cx("rounded-2xl rounded-br-md border border-lemon-line bg-lemon-soft px-4 py-2.5 text-ink", pending && "opacity-70")}>
          <LongText text={text} />
          {canShowImages && <SentImages images={images!} />}
          {listed && listed.length > 0 && (
            <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1">
              {listed.map(f => (
                <li key={f} className="inline-flex h-6 max-w-[220px] items-center gap-1 rounded-md bg-paper/70 px-2 text-[12px] text-ink-soft">
                  <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{attachmentLabel(f)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 pr-1 text-xs text-ink-faint">
          {!pending && (
            <MessageActions>
              <ActionButton
                label={copied ? "Copied" : "Copy message"}
                icon={copied ? <Check aria-hidden="true" className="size-3.5 text-leaf" /> : <Copy aria-hidden="true" className="size-3.5" />}
                onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
              >
                {copied ? "Copied" : "Copy"}
              </ActionButton>
              {onEdit && (
                <ActionButton label="Edit and send again" icon={<Pencil aria-hidden="true" className="size-3.5" />} onClick={onEdit}>
                  Edit
                </ActionButton>
              )}
              {onFork && (
                <ActionButton label="Fork into a new thread" icon={<GitFork aria-hidden="true" className="size-3.5" />} onClick={onFork}>
                  Fork
                </ActionButton>
              )}
              {onRewind && (
                <Menu
                  align="end"
                  trigger={
                    <button
                      type="button"
                      aria-label="Go back to this message"
                      className="inline-flex size-7 items-center justify-center rounded-md text-ink-soft hover:bg-cream-deep hover:text-ink data-[popup-open]:bg-cream-deep"
                    >
                      <MoreHorizontal aria-hidden="true" className="size-4" />
                    </button>
                  }
                >
                  <MenuItem icon={<Undo2 />} onSelect={() => onRewind(false)}>
                    Go back to here
                  </MenuItem>
                  <MenuItem icon={<History />} disabled={!restorable} onSelect={() => onRewind(true)}>
                    Go back and restore files
                  </MenuItem>
                </Menu>
              )}
            </MessageActions>
          )}
          <span className="ml-1">{pending ? "Sending…" : clockTime(at)}</span>
        </div>
      </div>
    </div>
  );
}

/** A sent message; a long one shows its start and end, with the middle a click away. */
function LongText({ text }: { text: string }) {
  const cut = useMemo(() => collapseLongText(text), [text]);
  const [all, setAll] = useState(false);
  const bodyId = useId();
  if (!cut) return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>;
  const toggle = (
    <button
      type="button"
      aria-expanded={all}
      aria-controls={bodyId}
      onClick={() => setAll(a => !a)}
      className="my-1.5 flex w-full items-center gap-2.5 text-[12px] font-medium text-ink-soft hover:text-ink"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-lemon-line" />
      {all ? (
        "Show less"
      ) : (
        <span>
          Show all
          <span className="font-normal tabular-nums">
            {cut.hiddenLines > 0 ? ` (${cut.hiddenLines.toLocaleString()} more lines)` : ` (${cut.hiddenChars.toLocaleString()} more characters)`}
          </span>
        </span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-lemon-line" />
    </button>
  );
  return (
    <div id={bodyId}>
      {all ? (
        <>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
          {toggle}
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{cut.head}</p>
          {toggle}
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{cut.tail}</p>
        </>
      )}
    </div>
  );
}

/** "It resets at 3:00 PM." or, further off, "It resets on Mon 9 Nov at 3:00 PM." */
function resetsWhen(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `It resets at ${time}.` : `It resets on ${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} at ${time}.`;
}

type ToolResult = { output: unknown; isError: boolean; exitCode?: number };

/** A tool's input and what came back. */
function ToolDetails({ input, result, running }: { input: unknown; result: ToolResult | null; running: boolean }) {
  const inputText = stringifyValue(input);
  const outputText = result ? stringifyValue(result.output) : "";
  return (
    <div className="flex flex-col gap-2.5 py-1">
      {inputText && <CodeBlock label="Input" text={inputText} />}
      {result ? (
        <CodeBlock label={result.isError ? "Error" : "Output"} text={outputText || "(no output)"} error={result.isError} />
      ) : (
        <p className="text-[13px] text-ink-faint">{running ? "Waiting for the result." : "It stopped before it finished."}</p>
      )}
    </div>
  );
}

/** A shell command and what it printed, the way a terminal shows it, with how it exited. */
function TerminalBlock({ command, result }: { command: string; result: ToolResult | null }) {
  const out = useMemo(() => (result ? commandOutput(result.output, result.exitCode) : null), [result]);
  const tail = useMemo(() => (out ? terminalTail(out.text) : null), [out]);
  const [all, setAll] = useState(false);
  const failed = result !== null && (result.isError || (out?.exitCode ?? 0) !== 0);
  const status = !result ? "Running" : out?.exitCode !== null && out?.exitCode !== undefined ? `Exit code ${out.exitCode}` : failed ? "Failed" : "Done";
  return (
    <div className="my-1 overflow-hidden rounded-lg bg-rind font-mono text-[12px] leading-relaxed">
      <div className="scroll-thin max-h-[420px] overflow-auto px-3 py-2.5">
        <pre className="font-medium whitespace-pre-wrap text-rind-text [overflow-wrap:anywhere]">
          <span aria-hidden="true" className="text-lime select-none">
            ${" "}
          </span>
          {command}
        </pre>
        {tail && tail.hiddenLines > 0 && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(a => !a)}
            className="mt-1.5 font-sans text-[12px] text-rind-muted underline underline-offset-2 hover:text-rind-text"
          >
            {all ? "Show only the last lines" : `Show ${tail.hiddenLines.toLocaleString()} earlier lines`}
          </button>
        )}
        {out && out.text && <pre className="mt-1.5 whitespace-pre-wrap text-rind-muted [overflow-wrap:anywhere]">{all ? out.text : tail!.shown}</pre>}
        {out && !out.text && <p className="mt-1.5 font-sans text-rind-muted">No output</p>}
      </div>
      <div className="flex items-center gap-1.5 border-t border-rind-line px-3 py-1.5 font-sans text-[12px]">
        {!result ? (
          <Spinner className="size-3 text-lime" />
        ) : failed ? (
          <CircleAlert aria-hidden="true" className="size-3.5 text-rind-danger" />
        ) : (
          <Check aria-hidden="true" className="size-3.5 text-lime" />
        )}
        <span className={cx("tabular-nums", failed ? "text-rind-danger" : "text-rind-text")}>{status}</span>
      </div>
    </div>
  );
}

function CodeBlock({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-[12px] font-medium text-ink-soft">{label}</p>
      <pre
        className={cx(
          "scroll-thin max-h-72 overflow-auto rounded-lg border px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
          error ? "border-danger/20 bg-danger-soft/60 text-diff-del-strong" : "border-line bg-cream text-ink",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

const STATUS_SENTENCE: Partial<Record<ThreadStatus, string>> = {
  running: "Agent started working",
  idle: "Agent finished",
  paused: "Sandbox paused",
  provisioning: "Starting sandbox",
  stopped: "Thread stopped",
  failed: "Thread failed",
};

function StatusRow({ to, reason, at, workedMs }: { to: ThreadStatus; reason?: string | undefined; at: string; workedMs?: number | undefined }) {
  return (
    <div className="flex items-center gap-3 py-0.5 text-xs text-ink-faint" role="note">
      <span className="h-px flex-1 bg-line" />
      <span className="tabular-nums">
        {workedMs !== undefined
          ? `Worked for ${formatDuration(workedMs)}, finished at ${clockTime(at)}`
          : `${STATUS_SENTENCE[to] ?? STATUS_LABELS[to]} at ${clockTime(at)}`}
        {reason ? `: ${reason}` : ""}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function ErrorRow({ message, code, fatal }: { message: string; code?: string | undefined; fatal: boolean }) {
  return (
    <div className="flex gap-3 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-ink" role="alert">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="font-medium text-danger">{fatal ? "The thread stopped because of an error" : "Something went wrong"}</p>
        <p className="mt-0.5 text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
        {code && <p className="mt-1 font-mono text-xs text-ink-soft">{code}</p>}
      </div>
    </div>
  );
}
