import { rewindMessage, withoutRewound, type EventOf, type ThreadEvent } from "@lemonlime/protocol";

/** What the thread view renders, built from the raw event history. */
export type TimelineItem =
  | { kind: "user"; key: string; text: string; at: string; pending?: boolean; queued?: boolean }
  | { kind: "agent"; key: string; text: string; at: string; streaming: boolean }
  | { kind: "tool"; key: string; call: EventOf<"tool_call">; result: EventOf<"tool_result"> | null }
  | { kind: "diff"; key: string; event: EventOf<"file_diff"> }
  | { kind: "status"; key: string; event: EventOf<"status_change"> }
  | { kind: "error"; key: string; event: EventOf<"error"> }
  | { kind: "notice"; key: string; event: EventOf<"notice"> }
  | { kind: "approval"; key: string; request: EventOf<"approval_request">; result: EventOf<"approval_result"> | null };

export interface PendingMessage {
  clientMsgId: string;
  text: string;
  at: string;
}

/**
 * Turn events (sorted by seq) into timeline items:
 * - streaming `agent_message` chunks are joined; a whole message replaces the chunks before it,
 * - each `tool_result` is attached to its `tool_call`,
 * - messages in the runner's queue show as queued, other optimistic messages as pending,
 *   until the runner echoes them back.
 */
export function buildTimeline(all: readonly ThreadEvent[], pending: readonly PendingMessage[] = []): TimelineItem[] {
  const events = withoutRewound(all);
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  const echoed = new Set<string>();
  const approvals = new Map<string, Extract<TimelineItem, { kind: "approval" }>>();
  let streaming: Extract<TimelineItem, { kind: "agent" }> | null = null;

  let queue: EventOf<"queue_update">["queue"] = [];
  for (const e of events) {
    // The queue changing doesn't interrupt what the agent is writing.
    if (e.type === "queue_update") {
      queue = e.queue;
      continue;
    }
    if (e.type !== "agent_message") streaming = null;
    switch (e.type) {
      case "user_message":
        if (e.clientMsgId) echoed.add(e.clientMsgId);
        items.push({ kind: "user", key: `e${e.seq}`, text: e.text, at: e.at });
        break;
      case "agent_message":
        if (e.partial) {
          if (streaming) streaming.text += e.text;
          else {
            streaming = { kind: "agent", key: `e${e.seq}`, text: e.text, at: e.at, streaming: true };
            items.push(streaming);
          }
        } else if (streaming) {
          streaming.text = e.text;
          streaming.streaming = false;
          streaming = null;
        } else {
          items.push({ kind: "agent", key: `e${e.seq}`, text: e.text, at: e.at, streaming: false });
        }
        break;
      case "tool_call": {
        const item = { kind: "tool" as const, key: `e${e.seq}`, call: e, result: null };
        tools.set(e.callId, item);
        items.push(item);
        break;
      }
      case "tool_result": {
        const call = tools.get(e.callId);
        if (call) call.result = e;
        else {
          // A result without a call we know of (e.g. history trimmed): show it on its own.
          items.push({
            kind: "tool",
            key: `e${e.seq}`,
            call: { type: "tool_call", threadId: e.threadId, seq: e.seq, at: e.at, callId: e.callId, name: "tool", input: undefined },
            result: e,
          });
        }
        break;
      }
      case "file_diff":
        items.push({ kind: "diff", key: `e${e.seq}`, event: e });
        break;
      case "status_change":
        items.push({ kind: "status", key: `e${e.seq}`, event: e });
        break;
      case "error":
        items.push({ kind: "error", key: `e${e.seq}`, event: e });
        break;
      case "notice":
        items.push({ kind: "notice", key: `e${e.seq}`, event: e });
        break;
      case "rewind":
        items.push({ kind: "notice", key: `e${e.seq}`, event: { ...e, type: "notice", code: "rewind", message: rewindMessage(e) } });
        break;
      case "approval_request": {
        const item = { kind: "approval" as const, key: `e${e.seq}`, request: e, result: null as EventOf<"approval_result"> | null };
        approvals.set(e.requestId, item);
        items.push(item);
        break;
      }
      case "approval_result": {
        const item = approvals.get(e.requestId);
        if (item) item.result = e;
        break;
      }
    }
  }

  const queued = new Set<string>();
  for (const q of queue) {
    if (echoed.has(q.clientMsgId)) continue;
    queued.add(q.clientMsgId);
    items.push({ kind: "user", key: `p${q.clientMsgId}`, text: q.text, at: q.queuedAt, pending: true, queued: true });
  }
  for (const p of pending) {
    if (!echoed.has(p.clientMsgId) && !queued.has(p.clientMsgId)) items.push({ kind: "user", key: `p${p.clientMsgId}`, text: p.text, at: p.at, pending: true });
  }
  return items;
}

/** Insert an event into a seq-sorted list, ignoring duplicates. */
export function addEvent(events: readonly ThreadEvent[], event: ThreadEvent): ThreadEvent[] {
  const last = events[events.length - 1];
  if (!last || last.seq < event.seq) return [...events, event];
  if (events.some(e => e.seq === event.seq)) return events as ThreadEvent[];
  return [...events, event].sort((a, b) => a.seq - b.seq);
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

/** Classify the lines of a unified diff for display. */
export function diffLines(diff: string): Array<{ kind: DiffLineKind; text: string }> {
  return diff
    .replace(/\n$/, "")
    .split("\n")
    .map(text => {
      if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) {
        return { kind: "meta" as const, text };
      }
      if (text.startsWith("@@")) return { kind: "hunk" as const, text };
      if (text.startsWith("+")) return { kind: "add" as const, text };
      if (text.startsWith("-")) return { kind: "del" as const, text };
      return { kind: "context" as const, text };
    });
}
