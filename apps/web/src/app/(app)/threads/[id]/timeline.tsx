"use client";

import { useState } from "react";
import type { EventOf } from "@lemonlime/protocol";
import { diffLines, type DiffLineKind, type TimelineItem } from "@/lib/timeline.ts";

const MAX_OUTPUT_CHARS = 20_000;

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[${text.length - MAX_OUTPUT_CHARS} more characters]` : text;
}

/** One-line hint of what a tool call does, from common input fields. */
function toolSummary(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v.every(x => typeof x === "string")) return v.join(" ");
  }
  return "";
}

const STATUS_TEXT: Record<string, string> = {
  provisioning: "Sandbox starting",
  idle: "Agent is waiting",
  running: "Agent is working",
  paused: "Sandbox paused",
  stopped: "Thread closed",
  failed: "Thread failed",
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export type ApproveFn = (requestId: string, decision: "allow" | "deny") => void;

export function Timeline({ items, onApprove }: { items: TimelineItem[]; onApprove?: ApproveFn }) {
  return (
    <ol className="space-y-4">
      {items.map(item => (
        <li key={item.key}>
          <Item item={item} onApprove={onApprove} />
        </li>
      ))}
    </ol>
  );
}

const DECLINED_BECAUSE: Record<string, string> = {
  timeout: "nobody answered in time",
  interrupted: "the turn was stopped",
  expired: "the runner restarted before anyone answered",
};

function Approval({ item, onApprove }: { item: Extract<TimelineItem, { kind: "approval" }>; onApprove?: ApproveFn | undefined }) {
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);
  const { request, result } = item;
  if (result) {
    const why = result.decision === "deny" && result.by !== "user" ? DECLINED_BECAUSE[result.by] : undefined;
    return (
      <p className="text-[13.5px] text-muted">
        {result.decision === "allow" ? "Allowed" : "Not allowed"}
        {why ? ` (${why})` : ""}: <code className="font-mono text-[12.5px] text-ink">{request.summary}</code>
      </p>
    );
  }
  const answer = (d: "allow" | "deny") => {
    if (sent || !onApprove) return;
    setSent(d);
    onApprove(request.requestId, d);
  };
  const isCommand = /^(bash|shell|execute|run|terminal)/i.test(request.tool);
  return (
    <div role="group" aria-label="The agent is asking for permission" className="rounded-2xl border border-line bg-paper px-4 py-3.5">
      <p className="font-medium">{isCommand ? "The agent wants to run this command" : `The agent wants to use ${request.tool}`}</p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-cream px-3 py-2 font-mono text-[12.5px]">
        {request.summary}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-lemon h-8" disabled={sent !== null || !onApprove} onClick={() => answer("allow")}>
          Allow
        </button>
        <button type="button" className="btn-ghost h-8" disabled={sent !== null || !onApprove} onClick={() => answer("deny")}>
          Don&apos;t allow
        </button>
        <span className="text-[13.5px] text-muted">The agent waits for your answer.</span>
      </div>
    </div>
  );
}

function Item({ item, onApprove }: { item: TimelineItem; onApprove?: ApproveFn | undefined }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex flex-col items-end">
          <div className={`max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-relaxed text-cream ${item.pending ? "opacity-60" : ""}`}>
            <p className="whitespace-pre-wrap break-words">{item.text}</p>
          </div>
          {item.queued ? <p className="mt-1 pr-1 text-[13.5px] text-muted">Queued, runs when the agent finishes</p> : null}
        </div>
      );
    case "agent":
      return (
        <div className="max-w-[95%] text-[0.9375rem] leading-relaxed">
          <p className="whitespace-pre-wrap break-words">
            {item.text}
            {item.streaming && <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-leaf align-text-bottom" />}
          </p>
          <span className="mt-1 block text-xs text-muted">{time(item.at)}</span>
        </div>
      );
    case "tool":
      return <ToolItem call={item.call} result={item.result} />;
    case "diff":
      return <DiffItem event={item.event} />;
    case "status":
      return (
        <div className="flex items-center gap-3 text-xs text-muted" role="status">
          <span className="h-px flex-1 bg-line" />
          <span>
            {STATUS_TEXT[item.event.to] ?? item.event.to}
            {item.event.reason ? `: ${item.event.reason}` : ""} · {time(item.event.at)}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "approval":
      return <Approval item={item} onApprove={onApprove} />;
    case "notice":
      return (
        <div role="status" className="rounded-xl border border-line bg-cream px-4 py-2.5 text-[13.5px] text-muted">
          <p className="whitespace-pre-wrap break-words">
            {item.event.message}
            {item.event.untilAt && <ResetTime iso={item.event.untilAt} />}
          </p>
        </div>
      );
    case "error":
      return (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-medium">{item.event.fatal ? "The thread stopped with an error" : "The agent hit an error"}</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{item.event.message}</p>
          {item.event.code && <p className="mt-1 font-mono text-xs text-red-800/80">{item.event.code}</p>}
        </div>
      );
  }
}

function ToolItem({ call, result }: { call: EventOf<"tool_call">; result: EventOf<"tool_result"> | null }) {
  const summary = toolSummary(call.input);
  const state = !result ? "running" : result.isError ? "error" : "done";
  return (
    <details className="group rounded-xl border border-line bg-paper text-sm open:shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${state === "running" ? "animate-pulse bg-[#c9a800]" : state === "error" ? "bg-red-600" : "bg-leaf"}`}
        />
        <span className="font-medium">{call.name}</span>
        {summary && <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-muted">{summary}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">{state === "running" ? "Running" : state === "error" ? "Failed" : "Done"}</span>
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-90" fill="currentColor">
          <path d="M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5z" />
        </svg>
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-3">
        {call.input !== undefined && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted">Input</p>
            <pre className="max-h-80 overflow-auto rounded-lg bg-cream p-3 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap break-words">
              {formatValue(call.input)}
            </pre>
          </div>
        )}
        {result && (
          <div>
            <p className={`mb-1 text-xs font-medium ${result.isError ? "text-red-700" : "text-muted"}`}>{result.isError ? "Error" : "Output"}</p>
            <pre className="max-h-96 overflow-auto rounded-lg bg-cream p-3 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap break-words">
              {formatValue(result.output) || "(no output)"}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

const LINE_STYLE: Record<DiffLineKind, string> = {
  add: "bg-lime/25 text-ink",
  del: "bg-red-100/70 text-red-950",
  hunk: "bg-cream text-muted",
  meta: "text-muted",
  context: "text-ink/80",
};

const CHANGE_LABEL = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" } as const;

function DiffItem({ event }: { event: EventOf<"file_diff"> }) {
  const lines = diffLines(event.diff);
  const adds = lines.filter(l => l.kind === "add").length;
  const dels = lines.filter(l => l.kind === "del").length;
  return (
    <details open={lines.length <= 80} className="group overflow-hidden rounded-xl border border-line bg-paper text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="rounded-md bg-lemon/50 px-1.5 py-0.5 text-xs font-medium">{CHANGE_LABEL[event.change]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">{event.path}</span>
        <span className="shrink-0 text-xs">
          <span className="text-leaf">+{adds}</span> <span className="text-red-700">-{dels}</span>
        </span>
      </summary>
      <div className="max-h-[32rem] overflow-auto border-t border-line">
        <pre className="min-w-max font-mono text-[0.8125rem] leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className={`px-4 ${LINE_STYLE[l.kind]}`}>
              {l.text || " "}
            </div>
          ))}
        </pre>
        {event.truncated && <p className="border-t border-line px-4 py-2 text-xs text-muted">Diff truncated: the file change is too large to show in full.</p>}
      </div>
    </details>
  );
}

/** When a limit resets, in the reader's own time zone (rendered in the browser). */
function ResetTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <>
      {" "}
      It resets at{" "}
      <time dateTime={iso} suppressHydrationWarning>
        {d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
      </time>
      .
    </>
  );
}
