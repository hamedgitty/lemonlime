import { withoutRewound, type ThreadEvent } from "./events.ts";

/** One turn: from the user's message until the agent stopped working on it. */
export interface TurnSpan {
  /** Seq of the user message that started the turn. */
  userSeq: number;
  startAt: string;
  /** When the agent stopped (its last status change away from running); null while it works, or if it never said. */
  endAt: string | null;
  /** Seq of that status change. */
  endSeq: number | null;
}

/**
 * Every turn in a history, worked out from event times alone, so it reads the same after a
 * reload. A turn ends at the last status change away from `running` before the next user
 * message; going back to `running` (a retry) carries the same turn on.
 */
export function turnSpans(all: readonly ThreadEvent[]): TurnSpan[] {
  const spans: TurnSpan[] = [];
  let current: TurnSpan | null = null;
  for (const e of withoutRewound(all)) {
    if (e.type === "user_message") {
      current = { userSeq: e.seq, startAt: e.at, endAt: null, endSeq: null };
      spans.push(current);
    } else if (current && e.type === "status_change") {
      if (e.to === "running") {
        current.endAt = null;
        current.endSeq = null;
      } else if (e.from === "running") {
        current.endAt = e.at;
        current.endSeq = e.seq;
      }
    }
  }
  return spans;
}

/** Milliseconds from `from` to `to` (ISO times), never negative; null if either is unreadable. */
export function elapsedMs(from: string, to: string | number): number | null {
  const a = Date.parse(from);
  const b = typeof to === "number" ? to : Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

/** "8s", "1m 12s", "3m", "1h 5m": how long something took, in whole seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
