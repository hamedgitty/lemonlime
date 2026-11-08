import { elapsedMs, rewindMessage, turnSpans, withoutRewound, type EventOf, type ThreadEvent } from "@lemonlime/protocol";

/** What the thread view renders, built from the raw event history. */
export type TimelineItem =
  | { kind: "user"; key: string; text: string; at: string; pending?: boolean; queued?: boolean }
  | { kind: "agent"; key: string; text: string; at: string; streaming: boolean }
  /** The agent's reasoning; it took from `startedAt` (the event before it) to `endedAt`. */
  | { kind: "reasoning"; key: string; text: string; at: string; streaming: boolean; startedAt: string; endedAt: string }
  | { kind: "tool"; key: string; call: EventOf<"tool_call">; result: EventOf<"tool_result"> | null }
  | { kind: "diff"; key: string; event: EventOf<"file_diff"> }
  /** `workedMs`: on the status change that ended a turn, how long the turn took. */
  | { kind: "status"; key: string; event: EventOf<"status_change">; workedMs?: number }
  | { kind: "error"; key: string; event: EventOf<"error"> }
  | { kind: "notice"; key: string; event: EventOf<"notice"> }
  | { kind: "approval"; key: string; request: EventOf<"approval_request">; result: EventOf<"approval_result"> | null }
  /** A plan from plan mode; `open` while nothing has been sent after it. */
  | { kind: "plan"; key: string; event: EventOf<"plan_proposal">; open: boolean }
  /** The agent's questions (answered in the form above the composer) and what came of them. */
  | { kind: "question"; key: string; request: EventOf<"question_request">; result: EventOf<"question_result"> | null }
  /**
   * The agent hit its usage limit: `open` while the thread is still stopped there (no turn
   * since), `waitingUntil` while the runner waits to try again (null: it didn't say when).
   */
  | { kind: "limit"; key: string; event: EventOf<"limit_hit">; open: boolean; waiting: boolean; waitingUntil: string | null }
  /** The thread carried on with another account or agent. */
  | { kind: "switch"; key: string; event: EventOf<"agent_switch"> };

/** Notices folded into the limit row: the runner waits to try again, or stopped waiting. */
const LIMIT_WAITING = new Set(["usage_limited", "retry_scheduled"]);
const LIMIT_NOT_WAITING = new Set(["retry_cancelled", "retry_given_up", "usage_limit_no_retry"]);

export interface PendingMessage {
  clientMsgId: string;
  text: string;
  at: string;
}

/**
 * Turn events (sorted by seq) into timeline items:
 * - streaming `agent_message` chunks are joined; a whole message replaces the chunks before it,
 *   and `agent_reasoning` streams the same way,
 * - the status change that ends a turn says how long the turn took,
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
  const questions = new Map<string, Extract<TimelineItem, { kind: "question" }>>();
  let lastPlan: Extract<TimelineItem, { kind: "plan" }> | null = null;
  let openLimit: Extract<TimelineItem, { kind: "limit" }> | null = null;
  const closeLimit = () => {
    if (openLimit) Object.assign(openLimit, { open: false, waiting: false, waitingUntil: null });
    openLimit = null;
  };
  let streaming: Extract<TimelineItem, { kind: "agent" }> | null = null;
  let thinking: Extract<TimelineItem, { kind: "reasoning" }> | null = null;
  let prevAt: string | null = null;
  const worked = new Map<number, number>();
  for (const t of turnSpans(events)) {
    const ms = t.endAt && t.endSeq !== null ? elapsedMs(t.startAt, t.endAt) : null;
    if (ms !== null) worked.set(t.endSeq!, ms);
  }

  let queue: EventOf<"queue_update">["queue"] = [];
  for (const e of events) {
    const before = prevAt;
    if (e.type !== "queue_update") prevAt = e.at;
    // The queue changing doesn't interrupt what the agent is writing.
    if (e.type === "queue_update") {
      queue = e.queue;
      continue;
    }
    // Neither do these, which show around the composer rather than in the timeline.
    if (e.type === "todo_snapshot" || e.type === "context_usage" || e.type === "options_change") continue;
    // Anything else ends a streaming message or reasoning.
    if (e.type !== "agent_message" && streaming) {
      streaming.streaming = false;
      streaming = null;
    }
    if (e.type !== "agent_reasoning" && thinking) {
      thinking.streaming = false;
      thinking = null;
    }
    switch (e.type) {
      case "agent_reasoning":
        if (thinking) {
          thinking.text = e.partial ? thinking.text + e.text : e.text;
          thinking.streaming = e.partial;
          thinking.endedAt = e.at;
          if (!e.partial) thinking = null;
        } else {
          const item = { kind: "reasoning" as const, key: `e${e.seq}`, text: e.text, at: e.at, streaming: e.partial, startedAt: before ?? e.at, endedAt: e.at };
          items.push(item);
          if (e.partial) thinking = item;
        }
        break;
      case "user_message":
        if (lastPlan) lastPlan.open = false;
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
        // The runner coming up (or a sandbox waking) isn't the agent finishing anything.
        if (e.to === "idle" && e.from !== "running") break;
        if (e.to === "running") closeLimit();
        items.push({ kind: "status", key: `e${e.seq}`, event: e, ...(worked.has(e.seq) ? { workedMs: worked.get(e.seq)! } : {}) });
        break;
      case "error":
        items.push({ kind: "error", key: `e${e.seq}`, event: e });
        break;
      case "notice":
        if (openLimit && LIMIT_WAITING.has(e.code)) {
          openLimit.waiting = true;
          openLimit.waitingUntil = e.untilAt ?? null;
          break;
        }
        if (openLimit && LIMIT_NOT_WAITING.has(e.code)) Object.assign(openLimit, { waiting: false, waitingUntil: null });
        items.push({ kind: "notice", key: `e${e.seq}`, event: e });
        break;
      case "limit_hit":
        closeLimit();
        openLimit = { kind: "limit", key: `e${e.seq}`, event: e, open: true, waiting: false, waitingUntil: null };
        items.push(openLimit);
        break;
      case "agent_switch":
        closeLimit();
        items.push({ kind: "switch", key: `e${e.seq}`, event: e });
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
      case "plan_proposal":
        if (lastPlan) lastPlan.open = false;
        lastPlan = { kind: "plan", key: `e${e.seq}`, event: e, open: true };
        items.push(lastPlan);
        break;
      case "question_request": {
        const item = { kind: "question" as const, key: `e${e.seq}`, request: e, result: null as EventOf<"question_result"> | null };
        questions.set(e.requestId, item);
        items.push(item);
        break;
      }
      case "question_result": {
        const item = questions.get(e.requestId);
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
