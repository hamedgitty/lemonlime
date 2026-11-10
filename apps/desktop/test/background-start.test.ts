import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { backgroundStartOutcome, firstMessageArrived, shouldLookAgain, type BackgroundStartInput } from "../src/lib/backgroundStart.ts";

const events = (list: NewEvent[]): ThreadEvent[] =>
  list.map((e, i) => ThreadEvent.parse({ ...e, threadId: "thread-0001", at: "2026-01-01T00:00:00.000Z", seq: i + 1 }));

/** A thread on this computer whose runner is still coming up. */
const starting: BackgroundStartInput = { arrived: false, state: "starting", error: null, cloudStatus: null };

describe("a thread started without being opened", () => {
  it("is done once its first message shows in the history", () => {
    expect(firstMessageArrived(events([{ type: "status_change", from: "idle", to: "running" }]))).toBe(false);
    expect(firstMessageArrived(events([{ type: "user_message", text: "Fix the build" }]))).toBe(true);
    expect(backgroundStartOutcome({ ...starting, state: "live", arrived: true })).toEqual({});
  });

  it("counts the message as arrived even if the connection has dropped since", () => {
    expect(backgroundStartOutcome({ ...starting, arrived: true, state: "error", error: "The connection closed." })).toEqual({});
    expect(backgroundStartOutcome({ ...starting, arrived: true, state: "offline", cloudStatus: "failed" })).toEqual({});
  });

  it("keeps waiting while the runner comes up and the message is on its way", () => {
    for (const state of ["starting", "connecting", "live", "reconnecting"] as const) {
      expect(backgroundStartOutcome({ ...starting, state })).toBeNull();
    }
  });

  it("gives up with the reason when the thread can't start", () => {
    expect(backgroundStartOutcome({ ...starting, state: "error", error: "Couldn't start the runner." })).toEqual({ problem: "Couldn't start the runner." });
    expect(backgroundStartOutcome({ ...starting, state: "offline", error: "Could not reach the control plane." })).toEqual({
      problem: "Could not reach the control plane.",
    });
  });

  it("still says something when it failed without a reason", () => {
    expect(backgroundStartOutcome({ ...starting, state: "error" })).toEqual({ problem: "The thread didn't start." });
  });

  it("gives up on a cloud thread whose sandbox failed or was stopped", () => {
    expect(backgroundStartOutcome({ ...starting, state: "offline", cloudStatus: "failed" })).toEqual({ problem: "Its sandbox didn't start." });
    expect(backgroundStartOutcome({ ...starting, state: "offline", cloudStatus: "stopped" })).toEqual({ problem: "Its sandbox didn't start." });
  });

  it("waits for a cloud sandbox that is still being set up, and looks again for its address", () => {
    const settingUp = { ...starting, state: "offline" as const, cloudStatus: "provisioning" as const };
    expect(backgroundStartOutcome(settingUp)).toBeNull();
    expect(shouldLookAgain(settingUp)).toBe(true);
  });

  it("doesn't keep asking once the sandbox is up, has failed, or the thread is on this computer", () => {
    expect(shouldLookAgain({ state: "live", cloudStatus: "running" })).toBe(false);
    expect(shouldLookAgain({ state: "connecting", cloudStatus: "provisioning" })).toBe(false);
    expect(shouldLookAgain({ state: "offline", cloudStatus: "failed" })).toBe(false);
    expect(shouldLookAgain({ state: "offline", cloudStatus: "paused" })).toBe(false);
    expect(shouldLookAgain({ state: "offline", cloudStatus: null })).toBe(false);
  });

  it("leaves a paused cloud thread waiting: its message wakes it", () => {
    expect(backgroundStartOutcome({ ...starting, state: "offline", cloudStatus: "paused" })).toBeNull();
  });
});
