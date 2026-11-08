import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  ChevronRight,
  CircleAlert,
  History,
  Info,
  MoreHorizontal,
  Paperclip,
  SquareTerminal,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react";
import { elapsedMs, formatDuration, type ThreadStatus } from "@lemonlime/protocol";
import { foldFinishedTurns, type TimelineItem } from "../lib/timeline.ts";
import { collapseLongText, commandOf, commandOutput, liveTurnStart, terminalTail, tocEntries, TOC_MIN_MESSAGES, unreadIndex } from "../lib/timelineView.ts";
import { flashItem } from "../lib/findInThread.ts";
import { StreamingMarkdown } from "../lib/markdown.tsx";
import type { EditQueuedFn } from "../lib/useThreadSession.ts";
import { Menu, MenuItem, MenuSeparator } from "./primitives.tsx";
import { STATUS_LABELS, clockTime, stringifyValue, summarizeToolInput } from "../lib/format.ts";
import { DiffView } from "./DiffView.tsx";
import { AgentMessage } from "./AgentMessage.tsx";
import { OptionsRow, PlanCard, QuestionRecord } from "./AgentLoop.tsx";
import { Button, Spinner, cx } from "./ui.tsx";
import { ImageLoaderContext, SentImages, useImageLoader, type LoadImage } from "./SentImages.tsx";
import { MessageRail } from "./MessageRail.tsx";

export type ApproveFn = (requestId: string, decision: "allow" | "deny") => void;
/** Go back to the user message at `seq` (its text goes back in the composer). */
export type RewindFn = (seq: number, text: string, restoreFiles: boolean) => void;

export function Timeline({
  items,
  working,
  empty,
  onApprove,
  onEditQueued,
  onRewind,
  onImplementPlan,
  foldFinished = false,
  unreadAfterSeq,
  loadImage,
}: {
  items: TimelineItem[];
  /** The last seq the user had seen when they opened the thread: a "New" divider goes after it. */
  unreadAfterSeq?: number | null | undefined;
  /** Fetches images sent with messages, while the runner can be reached. */
  loadImage?: LoadImage | null | undefined;
  /** Fold each finished turn's steps into one line (Settings → Appearance). */
  foldFinished?: boolean;
  working: boolean;
  empty: ReactNode;
  onApprove?: ApproveFn;
  onEditQueued?: EditQueuedFn;
  onRewind?: RewindFn;
  /** Approve the latest plan (leave plan mode and tell the agent to go ahead). */
  onImplementPlan?: (() => void) | undefined;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const shown = useMemo(() => (foldFinished ? foldFinishedTurns(items) : items), [items, foldFinished]);
  const divider = useMemo(() => unreadIndex(shown, unreadAfterSeq), [shown, unreadAfterSeq]);
  const toc = useMemo(() => tocEntries(items), [items]);
  const turnStart = working ? liveTurnStart(items) : null;

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

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    setShowJump(!atBottom);
  };

  // Keep following new output while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, working]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Opening a thread with something new in it starts at the "New" divider, once.
  const shownUnread = useRef(false);
  useEffect(() => {
    if (shownUnread.current || divider < 0) return;
    shownUnread.current = true;
    const el = scrollRef.current;
    const node = el?.querySelector("[data-unread-divider]");
    if (!el || !node) return;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - 48;
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
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <ImageLoaderContext.Provider value={loadImage ?? null}>
      <div className="@container relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={showScrollbar}
          onTouchMove={showScrollbar}
          onKeyDown={showScrollbar}
          className="scroll-quiet relative h-full overflow-y-auto"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Thread timeline"
        >
          <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 pt-6 pb-10">
            {items.length === 0
              ? empty
              : shown.map((item, i) => (
                  <Fragment key={item.key}>
                    {i === divider && <UnreadDivider />}
                    {/* Off-screen messages skip layout and paint, so long chats stay fast. */}
                    <div
                      data-timeline-key={item.key}
                      data-flash-target
                      className={i < shown.length - 30 ? "[contain-intrinsic-size:auto_96px] [content-visibility:auto]" : undefined}
                    >
                      {item.kind === "fold" ? (
                        <div className="flex flex-col gap-4">
                          <button
                            type="button"
                            aria-expanded={unfolded.has(item.key)}
                            onClick={() =>
                              setUnfolded(u => {
                                const next = new Set(u);
                                if (next.has(item.key)) next.delete(item.key);
                                else next.add(item.key);
                                return next;
                              })
                            }
                            className="flex items-center gap-2 self-start rounded-full border border-line px-3 py-1 text-[13px] text-ink-soft hover:border-line-strong hover:text-ink"
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className={cx("size-3.5 transition-transform duration-150", unfolded.has(item.key) && "rotate-90")}
                            />
                            {item.workedMs !== undefined ? (
                              <>
                                <span className="tabular-nums">Worked for {formatDuration(item.workedMs)}</span>
                                <span className="text-ink-faint">{item.items.length} steps</span>
                              </>
                            ) : (
                              `Worked through ${item.items.length} steps`
                            )}
                          </button>
                          {unfolded.has(item.key) &&
                            item.items.map(it => (
                              <Item
                                key={it.key}
                                item={it}
                                onApprove={onApprove}
                                onEditQueued={onEditQueued}
                                onRewind={onRewind}
                                onImplementPlan={onImplementPlan}
                              />
                            ))}
                        </div>
                      ) : (
                        <Item item={item} onApprove={onApprove} onEditQueued={onEditQueued} onRewind={onRewind} onImplementPlan={onImplementPlan} />
                      )}
                    </div>
                  </Fragment>
                ))}
            {working && <WorkingLine since={turnStart} />}
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
      className="flex items-center gap-3 text-xs font-medium text-leaf"
    >
      <span className="h-px flex-1 bg-leaf/35" />
      New
      <span className="h-px flex-1 bg-leaf/35" />
    </div>
  );
}

const Item = memo(function Item({
  item,
  onApprove,
  onEditQueued,
  onRewind,
  onImplementPlan,
}: {
  item: TimelineItem;
  onApprove?: ApproveFn | undefined;
  onEditQueued?: EditQueuedFn | undefined;
  onRewind?: RewindFn | undefined;
  onImplementPlan?: (() => void) | undefined;
}) {
  switch (item.kind) {
    case "user":
      return item.queued && onEditQueued ? (
        <QueuedMessage text={item.text} queued={item.queued} onEdit={onEditQueued} />
      ) : (
        <UserMessage
          text={item.text}
          at={item.at}
          pending={item.pending}
          queued={Boolean(item.queued)}
          files={item.files}
          images={item.images}
          {...(onRewind && item.seq !== null && !item.pending
            ? { onRewind: (restore: boolean) => onRewind(item.seq!, item.text, restore), restorable: Boolean(item.restorable) }
            : {})}
        />
      );
    case "agent":
      return <AgentMessage text={item.text} streaming={item.streaming} />;
    case "reasoning":
      return <ReasoningRow text={item.text} streaming={item.streaming} startedAt={item.startedAt} endedAt={item.endedAt} />;
    case "tool":
      return <ToolCall name={item.name} input={item.input} result={item.result} />;
    case "diff":
      return <DiffView path={item.path} change={item.change} diff={item.diff} truncated={item.truncated} />;
    case "status":
      return <StatusRow to={item.to} reason={item.reason} at={item.at} workedMs={item.workedMs} />;
    case "error":
      return <ErrorRow message={item.message} code={item.code} fatal={item.fatal} />;
    case "notice":
      return <NoticeRow message={item.untilAt ? `${item.message} ${resetsWhen(item.untilAt)}` : item.message} />;
    case "approval":
      return <ApprovalCard item={item} onApprove={onApprove} />;
    case "plan":
      return <PlanCard plan={item.plan} open={item.open} onImplement={onImplementPlan} />;
    case "question":
      return <QuestionRecord questions={item.questions} answers={item.answers} state={item.state} by={item.by} />;
    case "options":
      return <OptionsRow options={item.options} />;
  }
});

const COMMAND_TOOLS = /^(bash|shell|execute|run|terminal)/i;

const DECLINED_BECAUSE: Record<string, string> = {
  timeout: "nobody answered in time",
  interrupted: "the turn was stopped",
  expired: "the runner restarted before anyone answered",
};

function ApprovalCard({ item, onApprove }: { item: Extract<TimelineItem, { kind: "approval" }>; onApprove?: ApproveFn | undefined }) {
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);
  const isCommand = COMMAND_TOOLS.test(item.tool);

  if (item.state !== "waiting") {
    const allowed = item.state === "allowed";
    const why = !allowed && item.by && item.by !== "user" ? DECLINED_BECAUSE[item.by] : undefined;
    return (
      <div className="flex items-start gap-2.5 px-1 text-[13.5px] text-ink-soft" role="note">
        {allowed ? (
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-leaf" />
        ) : (
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
        )}
        <p className="min-w-0 [overflow-wrap:anywhere]">
          {allowed ? "Allowed" : "Not allowed"}
          {why ? ` (${why})` : ""}: <code className="font-mono text-[12.5px] text-ink">{item.summary}</code>
        </p>
      </div>
    );
  }

  const answer = (decision: "allow" | "deny") => {
    if (sent || !onApprove) return;
    setSent(decision);
    onApprove(item.requestId, decision);
  };
  return (
    <div className="animate-rise rounded-2xl border border-[#f0d95c] bg-lemon-soft/70 px-4 py-3.5" role="group" aria-label="The agent is asking for permission">
      <p className="font-medium text-ink">{isCommand ? "The agent wants to run this command" : `The agent wants to use ${item.tool}`}</p>
      <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
        {item.summary}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Neither button takes focus by itself, so a stray Enter never approves anything. */}
        <Button variant="primary" size="sm" disabled={sent !== null || !onApprove} onClick={() => answer("allow")}>
          {sent === "allow" ? <Spinner /> : <Check aria-hidden="true" className="size-3.5" />}
          Allow
        </Button>
        <Button variant="secondary" size="sm" disabled={sent !== null || !onApprove} onClick={() => answer("deny")}>
          Don&apos;t allow
        </Button>
        <span className="text-[13.5px] text-ink-soft">The agent waits for your answer.</span>
      </div>
    </div>
  );
}

function NoticeRow({ message }: { message: string }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-line bg-cream-deep/60 px-4 py-2.5 text-[13.5px] text-ink-soft" role="status">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
      <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
    </div>
  );
}

function UserMessage({
  text,
  at,
  pending,
  queued,
  onRewind,
  restorable,
  files,
  images,
}: {
  text: string;
  at: string;
  pending: boolean;
  queued: boolean;
  onRewind?: (restoreFiles: boolean) => void;
  restorable?: boolean;
  files?: string[] | undefined;
  images?: { id: string; name: string }[] | undefined;
}) {
  const canShowImages = useImageLoader() !== null && Boolean(images?.length);
  // Images shown as thumbnails aren't listed again by name.
  const listed = canShowImages ? files?.filter(f => !images!.some(i => i.name === f)) : files;
  return (
    <div className="group flex animate-rise justify-end">
      <div className="max-w-[78%]">
        <div className={cx("rounded-2xl rounded-br-md border border-[#f0d95c] bg-lemon-soft px-4 py-2.5 text-ink", pending && "opacity-70")}>
          <LongText text={text} />
          {canShowImages && <SentImages images={images!} />}
          {listed && listed.length > 0 && (
            <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1">
              {listed.map(f => (
                <li key={f} className="inline-flex h-6 max-w-[220px] items-center gap-1 rounded-md bg-paper/70 px-2 text-[12.5px] text-ink-soft">
                  <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{f}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-1 flex items-center justify-end gap-1 pr-1 text-xs text-ink-faint">
          {onRewind && (
            <Menu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label="Go back to this message"
                  className="inline-flex size-6 items-center justify-center rounded-md opacity-0 hover:bg-ink/5 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
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
          <span>{queued ? "Queued, runs when the agent finishes" : pending ? "Sending…" : clockTime(at)}</span>
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
      className="my-1.5 flex w-full items-center gap-2.5 text-[12.5px] font-medium text-ink-soft hover:text-ink"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-[#e6cf4f]" />
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
      <span aria-hidden="true" className="h-px flex-1 bg-[#e6cf4f]" />
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

/** A message waiting for the agent: send it now, edit it, move it or take it back. */
function QueuedMessage({
  text,
  queued,
  onEdit,
}: {
  text: string;
  queued: NonNullable<Extract<TimelineItem, { kind: "user" }>["queued"]>;
  onEdit: EditQueuedFn;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const id = queued.clientMsgId;
  const save = () => {
    const next = draft.trim();
    if (next && next !== text) onEdit(id, { action: "update", text: next });
    setEditing(false);
  };
  return (
    <div className="flex justify-end">
      <div className={cx("flex max-w-[78%] flex-col items-end", editing && "w-full items-stretch")}>
        {editing ? (
          <div className="rounded-2xl rounded-br-md border border-[#f0d95c] bg-lemon-soft p-2">
            <textarea
              aria-label="Edit queued message"
              autoFocus
              onFocus={e => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  setDraft(text);
                  setEditing(false);
                }
              }}
              rows={Math.min(8, Math.max(2, draft.split("\n").length))}
              className="w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-ink outline-none"
            />
            <div className="flex justify-end gap-2 px-1 pb-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(text);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl rounded-br-md border border-dashed border-[#e9c900] bg-lemon-soft/60 px-4 py-2.5 text-ink">
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
          </div>
        )}
        {!editing && (
          <div className="mt-1 flex items-center justify-end gap-1 pr-1 text-xs text-ink-faint">
            <span className="mr-1">{queued.count > 1 ? `Queued, ${ordinal(queued.index + 1)} in line` : "Queued, runs when the agent finishes"}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => onEdit(id, { action: "send_now" })}>
              Send now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Menu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label="More for this queued message"
                  className="inline-flex size-6 items-center justify-center rounded-md text-ink-faint hover:bg-ink/5 hover:text-ink"
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </button>
              }
            >
              <MenuItem icon={<ArrowUpToLine />} disabled={queued.index === 0} onSelect={() => onEdit(id, { action: "move", toIndex: 0 })}>
                Move to front
              </MenuItem>
              <MenuItem
                icon={<ArrowDownToLine />}
                disabled={queued.index === queued.count - 1}
                onSelect={() => onEdit(id, { action: "move", toIndex: queued.count - 1 })}
              >
                Move to back
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} onSelect={() => onEdit(id, { action: "remove" })}>
                Remove from queue
              </MenuItem>
            </Menu>
          </div>
        )}
      </div>
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

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

type ToolResult = { output: unknown; isError: boolean; exitCode?: number };

function ToolCall({ name, input, result }: { name: string; input: unknown; result: ToolResult | null }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const command = commandOf(name, input);
  const summary = command ? command.split("\n")[0]! : summarizeToolInput(input);
  const inputText = stringifyValue(input);
  const outputText = result ? stringifyValue(result.output) : "";

  return (
    <div className={cx("rounded-xl border bg-paper", result?.isError ? "border-danger/30" : "border-line")}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-cream/60 focus-visible:-outline-offset-2"
      >
        <ChevronRight aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint transition-transform duration-150", open && "rotate-90")} />
        {command ? (
          <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0 text-ink-soft" />
        ) : (
          <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-ink-soft" />
        )}
        <span className="shrink-0 text-[13px] font-medium text-ink">{name}</span>
        {summary && <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-soft">{summary}</span>}
        {!summary && <span className="flex-1" />}
        {result === null ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
            <Spinner className="size-3 text-leaf" />
            Running
          </span>
        ) : result.isError ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
            <CircleAlert aria-hidden="true" className="size-3.5" />
            Failed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-leaf">
            <Check aria-hidden="true" className="size-3.5" />
            Done
          </span>
        )}
      </button>
      {open && command && (
        <div id={bodyId} className="border-t border-line p-2">
          <TerminalBlock command={command} result={result} />
        </div>
      )}
      {open && !command && (
        <div id={bodyId} className="flex flex-col gap-3 border-t border-line px-3 py-3">
          {inputText && <CodeBlock label="Input" text={inputText} />}
          {result ? (
            <CodeBlock label={result.isError ? "Error" : "Output"} text={outputText || "(no output)"} error={result.isError} />
          ) : (
            <p className="text-[13px] text-ink-faint">Waiting for the result.</p>
          )}
        </div>
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
    <div className="overflow-hidden rounded-lg bg-rind font-mono text-[12px] leading-relaxed">
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
          <CircleAlert aria-hidden="true" className="size-3.5 text-[#f2877e]" />
        ) : (
          <Check aria-hidden="true" className="size-3.5 text-lime" />
        )}
        <span className={cx("tabular-nums", failed ? "text-[#f2877e]" : "text-rind-text")}>{status}</span>
      </div>
    </div>
  );
}

/** The agent's reasoning: one quiet line ("Thought for 12s") that opens to the text. */
function ReasoningRow({ text, streaming, startedAt, endedAt }: { text: string; streaming: boolean; startedAt: string; endedAt: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const ms = elapsedMs(startedAt, endedAt);
  const label = streaming ? "Thinking" : ms !== null && ms >= 1000 ? `Thought for ${formatDuration(ms)}` : "Thought for a moment";
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-1 text-[13px] text-ink-faint hover:text-ink"
      >
        <ChevronRight aria-hidden="true" className={cx("size-3.5 transition-transform duration-150", open && "rotate-90")} />
        <span className="tabular-nums">{label}</span>
      </button>
      {open && (
        <div id={bodyId} className="mt-1 ml-[11px] border-l-2 border-line pl-4 text-ink-soft">
          <StreamingMarkdown text={text} className="text-[13.5px]" />
        </div>
      )}
    </div>
  );
}

function CodeBlock({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-soft">{label}</p>
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
        {workedMs !== undefined ? `Worked for ${formatDuration(workedMs)}` : (STATUS_SENTENCE[to] ?? STATUS_LABELS[to])}
        {reason ? ` · ${reason}` : ""} · {clockTime(at)}
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
        <p className="mt-0.5 whitespace-pre-wrap text-[13.5px] [overflow-wrap:anywhere]">{message}</p>
        {code && <p className="mt-1 font-mono text-xs text-ink-soft">{code}</p>}
      </div>
    </div>
  );
}
