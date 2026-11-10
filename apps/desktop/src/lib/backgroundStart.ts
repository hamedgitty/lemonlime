import type { ThreadEvent, ThreadStatus } from "@lemonlime/protocol";
import { writtenByPerson } from "./timeline.ts";

/**
 * A thread made without being opened is started in the background and handed its first
 * message. These say when that is over, so the caller can stop watching it.
 */

/** Whether the first message has reached the runner: it shows in the history as a message a person wrote. */
export function firstMessageArrived(events: readonly ThreadEvent[]): boolean {
  return events.some(writtenByPerson);
}

export interface BackgroundStartInput {
  /** The first message is in the thread's history. */
  arrived: boolean;
  /** The session's connection state. */
  state: "starting" | "connecting" | "live" | "reconnecting" | "offline" | "error";
  error: string | null;
  /** The control plane's status for a cloud thread; null for a thread on this computer. */
  cloudStatus: ThreadStatus | null;
}

/**
 * How the start went: `{}` once the message has arrived, a `problem` when the thread can't
 * start, or null while it is still on its way (a sandbox being set up, a runner coming up).
 */
export function backgroundStartOutcome(i: BackgroundStartInput): { problem?: string } | null {
  if (i.arrived) return {};
  if (i.state === "error" || (i.state === "offline" && i.error)) return { problem: i.error ?? "The thread didn't start." };
  if (i.state === "offline" && (i.cloudStatus === "failed" || i.cloudStatus === "stopped")) return { problem: "Its sandbox didn't start." };
  return null;
}

/** A cloud sandbox that is still being set up has no address yet, so the app looks again shortly. */
export function shouldLookAgain(i: Pick<BackgroundStartInput, "state" | "cloudStatus">): boolean {
  return i.state === "offline" && i.cloudStatus === "provisioning";
}
