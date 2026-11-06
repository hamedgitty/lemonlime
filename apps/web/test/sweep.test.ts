import { describe, expect, it, vi } from "vitest";
import { IDLE_PAUSE_AFTER_MS } from "@lemonlime/protocol";
import { RUNNER_SILENCE_PAUSE_MS, decideSweep, runtimeSeconds, sweepVerdict, type SweepThread } from "../src/lib/sweep.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function thread(over: Partial<SweepThread> = {}): SweepThread {
  return {
    id: "thread-1",
    mode: "cloud",
    status: "idle",
    sandboxId: "sb-1",
    idleSince: ago(60_000),
    runningSince: ago(10 * 60_000),
    lastHeartbeatAt: ago(20_000),
    ...over,
  };
}

describe("sweepVerdict", () => {
  it("skips local, paused and sandbox-less threads", () => {
    expect(sweepVerdict(thread({ mode: "local" }), NOW)).toEqual({ action: "skip" });
    expect(sweepVerdict(thread({ runningSince: null }), NOW)).toEqual({ action: "skip" });
    expect(sweepVerdict(thread({ sandboxId: null }), NOW)).toEqual({ action: "skip" });
  });

  it("pauses threads idle for the shared threshold", () => {
    expect(sweepVerdict(thread({ idleSince: ago(IDLE_PAUSE_AFTER_MS) }), NOW)).toEqual({ action: "pause", endReason: "idle" });
    expect(sweepVerdict(thread({ idleSince: ago(IDLE_PAUSE_AFTER_MS - 1) }), NOW)).toEqual({ action: "ask_policy" });
  });

  it("never idle-pauses a thread whose agent is working", () => {
    expect(sweepVerdict(thread({ status: "running", idleSince: null }), NOW)).toEqual({ action: "ask_policy" });
    expect(sweepVerdict(thread({ status: "running", idleSince: ago(IDLE_PAUSE_AFTER_MS * 3) }), NOW)).toEqual({ action: "ask_policy" });
  });

  it("pauses sandboxes whose runner went silent", () => {
    const silent = thread({ status: "provisioning", idleSince: null, lastHeartbeatAt: null, runningSince: ago(RUNNER_SILENCE_PAUSE_MS) });
    expect(sweepVerdict(silent, NOW)).toEqual({ action: "pause", endReason: "error" });
    const fresh = thread({ status: "provisioning", idleSince: null, lastHeartbeatAt: null, runningSince: ago(60_000) });
    expect(sweepVerdict(fresh, NOW)).toEqual({ action: "ask_policy" });
  });

  it("pauses sandboxes whose runner reports failure", () => {
    expect(sweepVerdict(thread({ status: "failed" }), NOW)).toEqual({ action: "pause", endReason: "error" });
  });
});

describe("decideSweep", () => {
  it("combines idle pauses with policy decisions", async () => {
    const idle = thread({ id: "idle-thread", idleSince: ago(IDLE_PAUSE_AFTER_MS + 1000) });
    const allowed = thread({ id: "allowed-thread", status: "running", idleSince: null });
    const denied = thread({ id: "denied-thread", status: "running", idleSince: null });
    const broken = thread({ id: "broken-thread", status: "running", idleSince: null });
    const local = thread({ id: "local-thread", mode: "local" });

    const policy = vi.fn(async (t: SweepThread) => {
      if (t.id === "denied-thread") return { allow: false as const, reason: "not allowed" };
      if (t.id === "broken-thread") throw new Error("policy unavailable");
      return { allow: true as const };
    });

    const result = await decideSweep([idle, allowed, denied, broken, local], NOW, policy);
    expect(result.pause.map(p => [p.thread.id, p.endReason])).toEqual([
      ["idle-thread", "idle"],
      ["denied-thread", "policy"],
    ]);
    expect(result.pause[1]?.reason).toBe("not allowed");
    expect(result.keep.map(t => t.id)).toEqual(["allowed-thread"]);
    expect(result.errors.map(e => e.thread.id)).toEqual(["broken-thread"]);
    // The policy is not asked about threads that are paused anyway or not running.
    expect(policy.mock.calls.map(([t]) => t.id).sort()).toEqual(["allowed-thread", "broken-thread", "denied-thread"]);
  });

  it("is a no-op for an empty or fully paused fleet", async () => {
    const policy = vi.fn();
    const result = await decideSweep([thread({ runningSince: null })], NOW, policy);
    expect(result).toEqual({ pause: [], keep: [], errors: [] });
    expect(policy).not.toHaveBeenCalled();
  });
});

describe("runtimeSeconds", () => {
  it("counts whole seconds and never goes negative", () => {
    expect(runtimeSeconds(ago(90_500), NOW)).toBe(90);
    expect(runtimeSeconds(new Date(NOW + 5000).toISOString(), NOW)).toBe(0);
    expect(runtimeSeconds("not a date", NOW)).toBe(0);
  });
});
