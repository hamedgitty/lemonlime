import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_KEEP_AWAKE_MS, DRAIN_TIMEOUT_MS, IDLE_PAUSE_AFTER_MS } from "@lemonlime/protocol";
import { RUNNER_SILENCE_PAUSE_MS, decideSweep, runSteps, runtimeSeconds, sweepVerdict, type SweepThread } from "../src/lib/sweep.ts";

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
    // Live runners drain first; a later sweep pauses them.
    expect(result.pause).toEqual([]);
    expect(result.drain.map(p => [p.thread.id, p.endReason])).toEqual([
      ["idle-thread", "idle"],
      ["denied-thread", "policy"],
    ]);
    expect(result.keep.map(t => t.id)).toEqual(["allowed-thread"]);
    expect(result.errors.map(e => e.thread.id)).toEqual(["broken-thread"]);
    // The policy is not asked about threads that are paused anyway or not running.
    expect(policy.mock.calls.map(([t]) => t.id).sort()).toEqual(["allowed-thread", "broken-thread", "denied-thread"]);
  });

  it("pauses after the runner drains, or after the drain timeout, and a silent runner at once", async () => {
    const policy = vi.fn(async () => ({ allow: true as const }));
    const idleSince = ago(IDLE_PAUSE_AFTER_MS + 1000);
    const asked = thread({ id: "asked", idleSince, drainRequestedAt: ago(10_000) });
    const drained = thread({ id: "drained", idleSince, drainRequestedAt: ago(10_000), drainedAt: ago(5_000) });
    const slow = thread({ id: "slow", idleSince, drainRequestedAt: ago(DRAIN_TIMEOUT_MS + 1000) });
    const silent = thread({
      id: "silent",
      status: "running",
      idleSince: null,
      lastHeartbeatAt: ago(RUNNER_SILENCE_PAUSE_MS + 1000),
      runningSince: ago(RUNNER_SILENCE_PAUSE_MS + 2000),
    });
    const result = await decideSweep([asked, drained, slow, silent], NOW, policy);
    expect(result.pause.map(p => p.thread.id).sort()).toEqual(["drained", "silent", "slow"]);
    expect(result.keep.map(t => t.id)).toEqual(["asked"]);
    expect(result.drain).toEqual([]);
  });

  it("keeps an idle sandbox awake for background work, up to the limit", async () => {
    const policy = vi.fn(async () => ({ allow: true as const }));
    const building = thread({ id: "building", idleSince: ago(IDLE_PAUSE_AFTER_MS + 1000), background: "build" });
    const tooLong = thread({ id: "too-long", idleSince: ago(BACKGROUND_KEEP_AWAKE_MS + 1000), background: "server" });
    const result = await decideSweep([building, tooLong], NOW, policy);
    expect(result.keep.map(t => t.id)).toEqual(["building"]);
    expect(result.drain.map(d => d.thread.id)).toEqual(["too-long"]);
  });

  it("is a no-op for an empty or fully paused fleet", async () => {
    const policy = vi.fn();
    const result = await decideSweep([thread({ runningSince: null })], NOW, policy);
    expect(result).toEqual({ pause: [], drain: [], keep: [], errors: [] });
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

describe("runSteps", () => {
  it("keeps going when one job fails, and names the job that failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const { results, failed } = await runSteps({
      first: async () => (order.push("first"), 1),
      broken: async () => {
        order.push("broken");
        throw new Error("no database");
      },
      last: async () => (order.push("last"), "done"),
    });
    expect(order).toEqual(["first", "broken", "last"]);
    expect(results).toEqual({ first: 1, broken: null, last: "done" });
    expect(failed).toEqual(["broken"]);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("reports nothing failed when every job works", async () => {
    expect(await runSteps({ a: async () => "x" })).toEqual({ results: { a: "x" }, failed: [] });
  });
});
