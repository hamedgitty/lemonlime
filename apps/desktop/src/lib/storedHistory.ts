import type { ThreadEvent } from "@lemonlime/protocol";
import type { CloudApi } from "./cloud.ts";

/** One catch-up reads this many pages at most; a later one carries on from there. */
const MAX_PAGES = 50;

/**
 * Reads what the control plane has kept of a cloud thread after `after`, a page at a time,
 * without waking its sandbox. Each page is handed over as it arrives, and `stopped` ends the
 * reading early. Resolves to the seq of the last event read.
 */
export async function readStoredHistory(
  api: Pick<CloudApi, "history">,
  threadId: string,
  after: number,
  onPage: (events: ThreadEvent[]) => void,
  stopped: () => boolean = () => false,
): Promise<number> {
  for (let page = 0; page < MAX_PAGES && !stopped(); page++) {
    const h = await api.history(threadId, after);
    if (stopped() || h.events.length === 0) break;
    onPage(h.events);
    after = h.events[h.events.length - 1]!.seq;
    if (!h.more) break;
  }
  return after;
}
