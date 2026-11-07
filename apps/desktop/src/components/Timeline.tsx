import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react";
import type { ThreadStatus } from "@lemonlime/protocol";
import type { TimelineItem } from "../lib/timeline.ts";
import type { EditQueuedFn } from "../lib/useThreadSession.ts";
import { Menu, MenuItem, MenuSeparator } from "./primitives.tsx";
import { STATUS_LABELS, clockTime, stringifyValue, summarizeToolInput } from "../lib/format.ts";
import { DiffView } from "./DiffView.tsx";
import { Button, LogoMark, Spinner, cx } from "./ui.tsx";

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
}: {
  items: TimelineItem[];
  working: boolean;
  empty: ReactNode;
  onApprove?: ApproveFn;
  onEditQueued?: EditQueuedFn;
  onRewind?: RewindFn;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

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

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin h-full overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Thread timeline"
      >
        <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 pt-6 pb-10">
          {items.length === 0
            ? empty
            : items.map((item, i) => (
                // Off-screen messages skip layout and paint, so long chats stay fast.
                <div key={item.key} className={i < items.length - 30 ? "[contain-intrinsic-size:auto_96px] [content-visibility:auto]" : undefined}>
                  <Item item={item} onApprove={onApprove} onEditQueued={onEditQueued} onRewind={onRewind} />
                </div>
              ))}
          {working && (
            <div className="flex items-center gap-2.5 pl-1 text-[13px] text-ink-soft">
              <span className="flex gap-1" aria-hidden="true">
                <span className="size-1.5 animate-pulse-soft rounded-full bg-leaf" />
                <span className="size-1.5 animate-pulse-soft rounded-full bg-leaf [animation-delay:200ms]" />
                <span className="size-1.5 animate-pulse-soft rounded-full bg-leaf [animation-delay:400ms]" />
              </span>
              The agent is working
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-white px-3 py-1.5 text-[13px] font-medium text-ink shadow-pop hover:bg-cream"
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
          Latest
        </button>
      )}
    </div>
  );
}

const Item = memo(function Item({
  item,
  onApprove,
  onEditQueued,
  onRewind,
}: {
  item: TimelineItem;
  onApprove?: ApproveFn | undefined;
  onEditQueued?: EditQueuedFn | undefined;
  onRewind?: RewindFn | undefined;
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
          {...(onRewind && item.seq !== null && !item.pending
            ? { onRewind: (restore: boolean) => onRewind(item.seq!, item.text, restore), restorable: Boolean(item.restorable) }
            : {})}
        />
      );
    case "agent":
      return <AgentMessage text={item.text} streaming={item.streaming} />;
    case "tool":
      return <ToolCall name={item.name} input={item.input} result={item.result} />;
    case "diff":
      return <DiffView path={item.path} change={item.change} diff={item.diff} truncated={item.truncated} />;
    case "status":
      return <StatusRow to={item.to} reason={item.reason} at={item.at} />;
    case "error":
      return <ErrorRow message={item.message} code={item.code} fatal={item.fatal} />;
    case "notice":
      return <NoticeRow message={item.untilAt ? `${item.message} ${resetsWhen(item.untilAt)}` : item.message} />;
    case "approval":
      return <ApprovalCard item={item} onApprove={onApprove} />;
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
      <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-white px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
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
}: {
  text: string;
  at: string;
  pending: boolean;
  queued: boolean;
  onRewind?: (restoreFiles: boolean) => void;
  restorable?: boolean;
  files?: string[] | undefined;
}) {
  return (
    <div className="group flex animate-rise justify-end">
      <div className="max-w-[78%]">
        <div className={cx("rounded-2xl rounded-br-md border border-[#f0d95c] bg-lemon-soft px-4 py-2.5 text-ink", pending && "opacity-70")}>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
          {files && files.length > 0 && (
            <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1">
              {files.map(f => (
                <li key={f} className="inline-flex h-6 max-w-[220px] items-center gap-1 rounded-md bg-white/70 px-2 text-[12.5px] text-ink-soft">
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

function AgentMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5">
        <LogoMark size={22} />
      </div>
      <div className="prose-agent min-w-0 flex-1 text-[14.5px] leading-relaxed text-ink">
        <RichText text={text} />
        {streaming && <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 animate-pulse-soft rounded-sm bg-leaf" />}
      </div>
    </div>
  );
}

/** Minimal formatting for agent text: fenced code blocks and inline code. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf("\n");
          const code = nl >= 0 && /^[\w+-]*$/.test(part.slice(0, nl).trim()) ? part.slice(nl + 1) : part;
          return (
            <pre key={i}>
              <code>{code.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        // Drop the line breaks that only separate prose from a code block.
        let prose = part;
        if (i > 0) prose = prose.replace(/^\n/, "");
        if (i < parts.length - 1) prose = prose.replace(/\n$/, "");
        return <InlineCode key={i} text={prose} />;
      })}
    </>
  );
}

function InlineCode({ text }: { text: string }) {
  const bits = text.split(/`([^`\n]+)`/);
  return <>{bits.map((b, i) => (i % 2 === 1 ? <code key={i}>{b}</code> : b))}</>;
}

function ToolCall({ name, input, result }: { name: string; input: unknown; result: { output: unknown; isError: boolean } | null }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const summary = summarizeToolInput(input);
  const inputText = stringifyValue(input);
  const outputText = result ? stringifyValue(result.output) : "";

  return (
    <div className={cx("rounded-xl border bg-white", result?.isError ? "border-danger/30" : "border-line")}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-cream/60 focus-visible:-outline-offset-2"
      >
        <ChevronRight aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint transition-transform duration-150", open && "rotate-90")} />
        <Wrench aria-hidden="true" className="size-3.5 shrink-0 text-ink-soft" />
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
      {open && (
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

function StatusRow({ to, reason, at }: { to: ThreadStatus; reason?: string | undefined; at: string }) {
  return (
    <div className="flex items-center gap-3 py-0.5 text-xs text-ink-faint" role="note">
      <span className="h-px flex-1 bg-line" />
      <span>
        {STATUS_SENTENCE[to] ?? STATUS_LABELS[to]}
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
