import {
  elapsedMs,
  rewindMessage,
  turnSpans,
  withoutRewound,
  type EventOf,
  type Question,
  type ThreadEvent,
  type ThreadOptions,
  type ThreadStatus,
} from "@lemonlime/protocol";

/** A message the user sent that the runner has not echoed back yet. */
export interface PendingMessage {
  clientMsgId: string;
  text: string;
  at: string;
}

export type TimelineItem =
  | {
      kind: "user";
      key: string;
      seq: number | null;
      at: string;
      text: string;
      pending: boolean;
      queued?: { clientMsgId: string; index: number; count: number };
      /** Files can be put back to how they were when this was sent. */
      restorable?: boolean;
      /** Names of files sent with it. */
      files?: string[];
      /** Images sent with it (upload ids), shown as thumbnails. */
      images?: { id: string; name: string }[];
    }
  | { kind: "agent"; key: string; seq: number; at: string; text: string; streaming: boolean }
  /** The agent's reasoning; `startedAt` is when it began thinking (the event before it). */
  | { kind: "reasoning"; key: string; seq: number; at: string; text: string; streaming: boolean; startedAt: string; endedAt: string }
  | {
      kind: "tool";
      key: string;
      seq: number;
      at: string;
      callId: string;
      name: string;
      input: unknown;
      result: { seq: number; output: unknown; isError: boolean; exitCode?: number } | null;
    }
  | {
      kind: "diff";
      key: string;
      seq: number;
      at: string;
      path: string;
      change: EventOf<"file_diff">["change"];
      diff: string;
      truncated: boolean;
    }
  | {
      kind: "status";
      key: string;
      seq: number;
      at: string;
      from: ThreadStatus;
      to: ThreadStatus;
      reason?: string;
      /** Set where the agent stopped working on a turn: how long the turn took. */
      workedMs?: number;
    }
  | { kind: "error"; key: string; seq: number; at: string; message: string; code?: string; fatal: boolean }
  | { kind: "notice"; key: string; seq: number; at: string; message: string; code: string; untilAt?: string }
  | {
      kind: "approval";
      key: string;
      seq: number;
      at: string;
      requestId: string;
      tool: string;
      summary: string;
      /** "waiting" until the user (or a timeout) decides. */
      state: "waiting" | "allowed" | "denied";
      by?: "user" | "timeout" | "interrupted" | "expired";
    }
  /** A plan from plan mode; `open` while no message has followed it. */
  | { kind: "plan"; key: string; seq: number; at: string; plan: string; open: boolean }
  /** The agent's questions; answered in the form above the composer, recorded here. */
  | {
      kind: "question";
      key: string;
      seq: number;
      at: string;
      requestId: string;
      questions: Question[];
      answers: string[][] | null;
      state: "waiting" | "answered" | "declined";
      by?: "user" | "timeout" | "interrupted" | "expired";
    }
  | { kind: "options"; key: string; seq: number; at: string; options: ThreadOptions };

/**
 * Turns an event history into what the thread view shows:
 * - streaming `agent_message` chunks (`partial: true`) are joined into one message,
 *   and a whole message (`partial: false`) that follows them replaces the chunks;
 *   `agent_reasoning` streams the same way into a reasoning item;
 * - the status change that ends a turn says how long the turn took;
 * - each `tool_result` is attached to the `tool_call` with the same `callId`;
 * - messages waiting in the runner's queue (the latest `queue_update`) are appended as
 *   queued, and messages the runner has not received yet as pending.
 *
 * Events must be in seq order. Duplicate seqs are ignored.
 */
export function buildTimeline(all: readonly ThreadEvent[], pending: readonly PendingMessage[] = []): TimelineItem[] {
  const events = withoutRewound(all);
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();
  const approvalIndex = new Map<string, number>();
  const questionIndex = new Map<string, number>();
  let lastPlan = -1;
  let lastUserSeq = 0;
  const confirmed = new Set<string>();
  let queue: EventOf<"queue_update">["queue"] = [];
  let lastSeq = 0;
  // Index of the agent item still receiving chunks, or -1.
  let openAgent = -1;
  // The same for reasoning.
  let openReasoning = -1;
  // When the previous event happened: reasoning started then.
  let prevAt: string | null = null;
  const worked = new Map<number, number>();
  for (const t of turnSpans(events)) {
    const ms = t.endAt && t.endSeq !== null ? elapsedMs(t.startAt, t.endAt) : null;
    if (ms !== null) worked.set(t.endSeq!, ms);
  }
  const closeAgent = () => {
    const open = openAgent >= 0 ? items[openAgent] : undefined;
    if (open?.kind === "agent") open.streaming = false;
    openAgent = -1;
  };
  const closeReasoning = () => {
    const open = openReasoning >= 0 ? items[openReasoning] : undefined;
    if (open?.kind === "reasoning") open.streaming = false;
    openReasoning = -1;
  };

  for (const ev of events) {
    if (ev.seq <= lastSeq) continue;
    lastSeq = ev.seq;
    const before = prevAt;
    if (ev.type !== "queue_update") prevAt = ev.at;

    if (ev.type === "agent_reasoning") {
      closeAgent();
      const open = openReasoning >= 0 ? items[openReasoning] : undefined;
      if (open?.kind === "reasoning") {
        open.text = ev.partial ? open.text + ev.text : ev.text;
        open.streaming = ev.partial;
        open.endedAt = ev.at;
        if (!ev.partial) openReasoning = -1;
        continue;
      }
      items.push({
        kind: "reasoning",
        key: `e${ev.seq}`,
        seq: ev.seq,
        at: ev.at,
        text: ev.text,
        streaming: ev.partial,
        startedAt: before ?? ev.at,
        endedAt: ev.at,
      });
      openReasoning = ev.partial ? items.length - 1 : -1;
      continue;
    }

    if (ev.type === "agent_message") {
      closeReasoning();
      const open = openAgent >= 0 ? items[openAgent] : undefined;
      if (open && open.kind === "agent") {
        open.text = ev.partial ? open.text + ev.text : ev.text;
        open.streaming = ev.partial;
        if (!ev.partial) openAgent = -1;
        continue;
      }
      items.push({ kind: "agent", key: `e${ev.seq}`, seq: ev.seq, at: ev.at, text: ev.text, streaming: ev.partial });
      openAgent = ev.partial ? items.length - 1 : -1;
      continue;
    }

    // The queue changing doesn't interrupt what the agent is writing.
    if (ev.type === "queue_update") {
      queue = ev.queue;
      continue;
    }
    // Neither do the to-do list and the context meter, which show above the composer.
    if (ev.type === "todo_snapshot" || ev.type === "context_usage") continue;

    // Any other event ends a streaming message or reasoning.
    closeAgent();
    closeReasoning();

    switch (ev.type) {
      case "user_message":
        lastUserSeq = ev.seq;
        if (ev.clientMsgId) confirmed.add(ev.clientMsgId);
        items.push({
          kind: "user",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          text: ev.text,
          pending: false,
          ...(ev.commit ? { restorable: true } : {}),
          ...(ev.attachments?.length ? { files: ev.attachments.map(a => a.name) } : {}),
          ...(ev.attachments?.some(a => SHOWABLE_IMAGE.test(a.name))
            ? { images: ev.attachments.filter(a => SHOWABLE_IMAGE.test(a.name)).map(a => ({ id: a.id, name: a.name })) }
            : {}),
        });
        break;
      case "tool_call":
        toolIndex.set(ev.callId, items.length);
        items.push({
          kind: "tool",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          callId: ev.callId,
          name: ev.name,
          input: ev.input,
          result: null,
        });
        break;
      case "tool_result": {
        const idx = toolIndex.get(ev.callId);
        const call = idx === undefined ? undefined : items[idx];
        const result = { seq: ev.seq, output: ev.output, isError: ev.isError, ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}) };
        if (call?.kind === "tool") call.result = result;
        else
          items.push({
            kind: "tool",
            key: `e${ev.seq}`,
            seq: ev.seq,
            at: ev.at,
            callId: ev.callId,
            name: "Tool result",
            input: undefined,
            result,
          });
        break;
      }
      case "file_diff":
        items.push({
          kind: "diff",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          path: ev.path,
          change: ev.change,
          diff: ev.diff,
          truncated: ev.truncated,
        });
        break;
      case "status_change":
        items.push({
          kind: "status",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          from: ev.from,
          to: ev.to,
          ...(ev.reason ? { reason: ev.reason } : {}),
          ...(worked.has(ev.seq) ? { workedMs: worked.get(ev.seq)! } : {}),
        });
        break;
      case "notice":
        items.push({
          kind: "notice",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          message: ev.message,
          code: ev.code,
          ...(ev.untilAt ? { untilAt: ev.untilAt } : {}),
        });
        break;
      case "rewind":
        items.push({ kind: "notice", key: `e${ev.seq}`, seq: ev.seq, at: ev.at, message: rewindMessage(ev), code: "rewind" });
        break;
      case "approval_request":
        approvalIndex.set(ev.requestId, items.length);
        items.push({
          kind: "approval",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          requestId: ev.requestId,
          tool: ev.tool,
          summary: ev.summary,
          state: "waiting",
        });
        break;
      case "approval_result": {
        const i = approvalIndex.get(ev.requestId);
        const item = i === undefined ? undefined : items[i];
        if (item?.kind === "approval") {
          item.state = ev.decision === "allow" ? "allowed" : "denied";
          item.by = ev.by;
        }
        break;
      }
      case "plan_proposal":
        lastPlan = items.length;
        items.push({ kind: "plan", key: `e${ev.seq}`, seq: ev.seq, at: ev.at, plan: ev.plan, open: false });
        break;
      case "question_request":
        questionIndex.set(ev.requestId, items.length);
        items.push({
          kind: "question",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          requestId: ev.requestId,
          questions: ev.questions,
          answers: null,
          state: "waiting",
        });
        break;
      case "question_result": {
        const i = questionIndex.get(ev.requestId);
        const item = i === undefined ? undefined : items[i];
        if (item?.kind === "question") {
          item.state = ev.answers ? "answered" : "declined";
          item.answers = ev.answers;
          item.by = ev.by;
        }
        break;
      }
      case "options_change":
        items.push({ kind: "options", key: `e${ev.seq}`, seq: ev.seq, at: ev.at, options: ev.options });
        break;
      case "error":
        items.push({
          kind: "error",
          key: `e${ev.seq}`,
          seq: ev.seq,
          at: ev.at,
          message: ev.message,
          ...(ev.code ? { code: ev.code } : {}),
          fatal: ev.fatal,
        });
        break;
    }
  }

  // Only the latest plan can still be approved, and only until the user replies.
  const plan = lastPlan >= 0 ? items[lastPlan] : undefined;
  if (plan?.kind === "plan") plan.open = plan.seq > lastUserSeq;

  const queuedIds = new Set<string>();
  const waiting = queue.filter(q => !confirmed.has(q.clientMsgId));
  waiting.forEach((q, index) => {
    queuedIds.add(q.clientMsgId);
    items.push({
      kind: "user",
      key: `p${q.clientMsgId}`,
      seq: null,
      at: q.queuedAt,
      text: q.text,
      pending: true,
      queued: { clientMsgId: q.clientMsgId, index, count: waiting.length },
    });
  });
  for (const p of pending) {
    if (confirmed.has(p.clientMsgId) || queuedIds.has(p.clientMsgId)) continue;
    items.push({ kind: "user", key: `p${p.clientMsgId}`, seq: null, at: p.at, text: p.text, pending: true });
  }
  return items;
}

/** Images the runner sends back for showing (see its `GET /attachments/<id>/image`). */
const SHOWABLE_IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Client message ids the runner has echoed back, so pending copies can be dropped. */
export function confirmedClientIds(events: readonly ThreadEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const ev of events) if (ev.type === "user_message" && ev.clientMsgId) ids.add(ev.clientMsgId);
  return ids;
}

/**
 * Adds newly received events to a history, keeping it sorted by seq and free of
 * duplicates. Returns the same array when nothing changed.
 */
export function appendEvents(history: readonly ThreadEvent[], incoming: readonly ThreadEvent[]): ThreadEvent[] {
  if (incoming.length === 0) return history as ThreadEvent[];
  const last = history.length > 0 ? history[history.length - 1]!.seq : 0;
  const fresh = incoming.filter(e => e.seq > last);
  if (fresh.length === incoming.length && isSorted(fresh)) {
    return fresh.length === 0 ? (history as ThreadEvent[]) : [...history, ...fresh];
  }
  // Out-of-order or overlapping input: merge by seq.
  const bySeq = new Map<number, ThreadEvent>();
  for (const e of history) bySeq.set(e.seq, e);
  let changed = false;
  for (const e of incoming) {
    if (!bySeq.has(e.seq)) {
      bySeq.set(e.seq, e);
      changed = true;
    }
  }
  if (!changed) return history as ThreadEvent[];
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function isSorted(events: readonly ThreadEvent[]): boolean {
  for (let i = 1; i < events.length; i++) if (events[i]!.seq <= events[i - 1]!.seq) return false;
  return true;
}

/** The thread status implied by the latest `status_change`, if any. */
export function latestStatus(events: readonly ThreadEvent[]): ThreadStatus | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "status_change") return e.to;
  }
  return null;
}

/** Highest seq such that every seq from 1 up to it is present (what can be resumed from). */
export function contiguousSeq(events: readonly ThreadEvent[]): number {
  let expect = 1;
  for (const e of events) {
    if (e.seq < expect) continue;
    if (e.seq !== expect) break;
    expect += 1;
  }
  return expect - 1;
}

/** Steps of a finished turn folded into one line. */
export interface FoldedSteps {
  kind: "fold";
  key: string;
  items: TimelineItem[];
  /** How long the turn took, when known. */
  workedMs?: number;
}

/**
 * "Fold finished turns": in every turn but the last, the agent's working steps (tools,
 * diffs, status changes, notes in between) fold into one line. The prompt, the agent's
 * final message, errors and approvals stay in view.
 */
export function foldFinishedTurns(items: readonly TimelineItem[]): Array<TimelineItem | FoldedSteps> {
  const starts = items.flatMap((it, i) => (it.kind === "user" ? [i] : []));
  if (starts.length < 2) return [...items];
  const out: Array<TimelineItem | FoldedSteps> = items.slice(0, starts[0]);
  for (let t = 0; t < starts.length; t++) {
    const from = starts[t]!;
    const to = t + 1 < starts.length ? starts[t + 1]! : items.length;
    const turn = items.slice(from, to);
    if (t === starts.length - 1) {
      out.push(...turn);
      break;
    }
    const lastAgent = turn.map(it => it.kind).lastIndexOf("agent");
    const keep = (it: TimelineItem, i: number) =>
      i === 0 || i === lastAgent || it.kind === "error" || it.kind === "approval" || it.kind === "plan" || it.kind === "question";
    const folded = turn.filter((it, i) => !keep(it, i));
    out.push(turn[0]!);
    const end = turn.find(it => it.kind === "status" && it.workedMs !== undefined);
    const workedMs = end?.kind === "status" ? end.workedMs : undefined;
    if (folded.length > 1) out.push({ kind: "fold", key: `fold:${turn[0]!.key}`, items: folded, ...(workedMs !== undefined ? { workedMs } : {}) });
    else out.push(...folded);
    out.push(...turn.filter((it, i) => i !== 0 && keep(it, i)));
  }
  return out;
}
