import { canTakePart, type Thread } from "@lemonlime/protocol";
import { CloudError } from "./cloud.ts";
import { STATUS_LABELS, type DisplayStatus } from "./format.ts";
import type { ThreadEntry } from "./threads.ts";

/**
 * Who may do what in a thread. A thread on this computer is always its owner's. In a
 * workspace, a cloud thread can be read by every member, but only the person who started it
 * directs its agent, until they let the rest of the workspace take part.
 */

/** Stands where the composer would be in a thread someone else started and hasn't shared. */
export const READ_ONLY_NOTE = "Started by someone else in this workspace. Only they can direct this agent, unless they share the thread.";

/** The switch in the thread's menu, for the person who started it. */
export const SHARE_LABEL = "Let workspace members take part";
export const SHARE_HELP = "They can message the agent, use its sandbox and act with the agent account you signed in here.";

/** Whose a cloud thread is, when that is worth saying; null for your own thread that nobody else can direct. */
export type Sharing = "read-only" | "shared-with-you" | "shared-by-you";

export function sharingOf(thread: Pick<Thread, "mine" | "shared">): Sharing | null {
  if (!thread.mine) return thread.shared ? "shared-with-you" : "read-only";
  return thread.shared ? "shared-by-you" : null;
}

export interface ThreadAccess {
  /**
   * May message the agent, answer its approvals and questions, reach its sandbox, rename the
   * thread, and pause or resume it. False means reading along: the conversation and nothing else.
   */
  takePart: boolean;
  /** Gets the switch that lets the rest of the workspace take part. */
  canShare: boolean;
  /** The rest of the workspace may take part right now. */
  shared: boolean;
}

/**
 * What this person may do in a thread. `sharing` says whether the control plane told the
 * app whose its threads are: one that doesn't has no sharing to switch on, and every thread
 * it lists behaves as the person's own.
 */
export function threadAccess(entry: ThreadEntry, o: { sharing?: boolean } = {}): ThreadAccess {
  if (entry.mode === "local") return { takePart: true, canShare: false, shared: false };
  const t = entry.thread;
  return { takePart: canTakePart(t), canShare: t.mine && o.sharing === true, shared: t.shared };
}

/**
 * A thread's status in words. A thread that is only read along is never waiting for this
 * person: its agent waits for whoever directs it.
 */
export function statusLabel(status: DisplayStatus, sharing?: Sharing | null): string {
  return status === "idle" && sharing === "read-only" ? "Waiting for a reply" : STATUS_LABELS[status];
}

/** Whether a thread can only be read: a cloud thread someone else started and hasn't shared. */
export function readOnly(entry: ThreadEntry): boolean {
  return !threadAccess(entry).takePart;
}

/**
 * Why a cloud thread's agent can't be signed in from here, or null when it can. The login is
 * saved to the account of whoever asks, so the control plane refuses everyone but the person
 * who started the thread. Any other failure (a control plane without the route, a request
 * that didn't get through) is no reason to stop: the sign-in goes ahead.
 */
export function signInRefusal(err: unknown): string | null {
  return err instanceof CloudError && err.status === 403 ? err.message : null;
}
