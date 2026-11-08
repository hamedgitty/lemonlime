import type { DisplayStatus } from "./format.ts";

/**
 * The one status mark a sidebar row shows, by priority: an unread failure, the agent
 * waiting for you (an approval or a question), working, finished since you last looked,
 * an unsent draft, then a failure you've already seen.
 */
export type RowGlyph = "error" | "waiting" | "working" | "unread" | "draft" | "failed" | null;

export interface RowStateInput {
  status: DisplayStatus;
  /** Answers the agent is waiting for. */
  waiting: number;
  /** Latest event seq known for the thread. */
  latestSeq: number;
  /** The seq the user had seen when they last looked (undefined: never recorded). */
  seenSeq: number | undefined;
  createdAt: string;
  /** When this computer started recording what was seen (ISO); "" means not yet. */
  unreadSince: string;
  markedUnread: boolean;
  draft: boolean;
  /** Open on screen right now. */
  selected: boolean;
}

/** Finished (or failed) after the user last looked at it, or marked unread by hand. */
export function isUnread(i: Omit<RowStateInput, "waiting" | "draft">): boolean {
  if (i.markedUnread) return true;
  if (i.selected) return false;
  if (i.status === "running" || i.status === "provisioning") return false;
  // Threads from before the app kept track count as read; newer ones start unseen.
  const seen = i.seenSeq ?? (i.unreadSince && i.createdAt >= i.unreadSince ? 0 : undefined);
  if (seen === undefined) return false;
  return i.latestSeq > seen;
}

export function rowGlyph(i: RowStateInput): RowGlyph {
  const unread = isUnread(i);
  if (i.status === "failed" && unread) return "error";
  if (i.waiting > 0) return "waiting";
  if (i.status === "running" || i.status === "provisioning") return "working";
  if (unread) return "unread";
  if (i.draft) return "draft";
  if (i.status === "failed") return "failed";
  return null;
}

export const GLYPH_LABELS: Record<Exclude<RowGlyph, null>, string> = {
  error: "Failed, not seen yet",
  waiting: "Waiting for you",
  working: "Working",
  unread: "Finished, not seen yet",
  draft: "Unsent draft",
  failed: "Failed",
};

/** Threads where the agent is waiting for you (for the dock badge). */
export function waitingCount(rows: { id: string; waiting: number }[], archived: Record<string, string>): number {
  return rows.filter(r => r.waiting > 0 && !archived[r.id]).length;
}
