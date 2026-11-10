import { startsTurn, type TimelineItem } from "./timeline.ts";

/**
 * The newest "the runner restarted and cut the turn short" notice, while nothing has been
 * sent since: the one that offers Continue. Null when there is none.
 */
export function continuableRestart(items: readonly TimelineItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (startsTurn(it)) return null;
    if (it.kind === "error" && it.code === "turn_outcome_unknown") return it.key;
  }
  return null;
}
