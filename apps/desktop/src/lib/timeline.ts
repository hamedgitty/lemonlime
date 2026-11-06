import type { EventOf, ThreadEvent, ThreadStatus } from "@lemonlime/protocol";

/** A message the user sent that the runner has not echoed back yet. */
export interface PendingMessage {
  clientMsgId: string;
  text: string;
  at: string;
}

export type TimelineItem =
  | { kind: "user"; key: string; seq: number | null; at: string; text: string; pending: boolean }
  | { kind: "agent"; key: string; seq: number; at: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      key: string;
      seq: number;
      at: string;
      callId: string;
      name: string;
      input: unknown;
      result: { seq: number; output: unknown; isError: boolean } | null;
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
  | { kind: "status"; key: string; seq: number; at: string; from: ThreadStatus; to: ThreadStatus; reason?: string }
  | { kind: "error"; key: string; seq: number; at: string; message: string; code?: string; fatal: boolean };

/**
 * Turns an event history into what the thread view shows:
 * - streaming `agent_message` chunks (`partial: true`) are joined into one message,
 *   and a whole message (`partial: false`) that follows them replaces the chunks;
 * - each `tool_result` is attached to the `tool_call` with the same `callId`;
 * - user messages the runner has not confirmed yet are appended as pending.
 *
 * Events must be in seq order. Duplicate seqs are ignored.
 */
export function buildTimeline(events: readonly ThreadEvent[], pending: readonly PendingMessage[] = []): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();
  const confirmed = new Set<string>();
  let lastSeq = 0;
  // Index of the agent item still receiving chunks, or -1.
  let openAgent = -1;

  for (const ev of events) {
    if (ev.seq <= lastSeq) continue;
    lastSeq = ev.seq;

    if (ev.type === "agent_message") {
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

    // Any other event ends a streaming message.
    if (openAgent >= 0) {
      const open = items[openAgent];
      if (open?.kind === "agent") open.streaming = false;
      openAgent = -1;
    }

    switch (ev.type) {
      case "user_message":
        if (ev.clientMsgId) confirmed.add(ev.clientMsgId);
        items.push({ kind: "user", key: `e${ev.seq}`, seq: ev.seq, at: ev.at, text: ev.text, pending: false });
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
        const result = { seq: ev.seq, output: ev.output, isError: ev.isError };
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
        });
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

  for (const p of pending) {
    if (confirmed.has(p.clientMsgId)) continue;
    items.push({ kind: "user", key: `p${p.clientMsgId}`, seq: null, at: p.at, text: p.text, pending: true });
  }
  return items;
}

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
