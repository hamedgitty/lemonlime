import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, Check, ChevronRight, CircleAlert, Info, Wrench } from "lucide-react";
import type { ThreadStatus } from "@lemonlime/protocol";
import type { TimelineItem } from "../lib/timeline.ts";
import { STATUS_LABELS, clockTime, stringifyValue, summarizeToolInput } from "../lib/format.ts";
import { DiffView } from "./DiffView.tsx";
import { LogoMark, Spinner, cx } from "./ui.tsx";

export function Timeline({ items, working, empty }: { items: TimelineItem[]; working: boolean; empty: ReactNode }) {
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
          {items.length === 0 ? empty : items.map(item => <Item key={item.key} item={item} />)}
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

const Item = memo(function Item({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} at={item.at} pending={item.pending} queued={item.queued ?? false} />;
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
      return <NoticeRow message={item.message} />;
  }
});

function NoticeRow({ message }: { message: string }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-line bg-cream-deep/60 px-4 py-2.5 text-[13.5px] text-ink-soft" role="status">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-faint" />
      <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
    </div>
  );
}

function UserMessage({ text, at, pending, queued }: { text: string; at: string; pending: boolean; queued: boolean }) {
  return (
    <div className="flex animate-rise justify-end">
      <div className="max-w-[78%]">
        <div
          className={cx(
            "rounded-2xl rounded-br-md border border-[#f0d95c] bg-lemon-soft px-4 py-2.5 text-ink",
            pending && "opacity-70",
          )}
        >
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
        </div>
        <p className="mt-1 pr-1 text-right text-xs text-ink-faint">{queued ? "Queued, runs when the agent finishes" : pending ? "Sending…" : clockTime(at)}</p>
      </div>
    </div>
  );
}

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

function ToolCall({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result: { output: unknown; isError: boolean } | null;
}) {
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
        <ChevronRight
          aria-hidden="true"
          className={cx("size-4 shrink-0 text-ink-faint transition-transform duration-150", open && "rotate-90")}
        />
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
