import { IDLE_PAUSE_AFTER_MS, type ThreadMode, type ThreadStatus } from "@lemonlime/protocol";
import type { PolicyDecision, SandboxRun } from "@lemonlime/plugins";

/**
 * A runner heartbeats every ~30 s. If a running sandbox has been silent for this
 * long, its runner is gone (crashed, never started) and the sandbox is paused.
 */
export const RUNNER_SILENCE_PAUSE_MS = 2 * IDLE_PAUSE_AFTER_MS;

export type EndReason = SandboxRun["endReason"];

/** The fields of a thread the sweep looks at. */
export interface SweepThread {
  id: string;
  mode: ThreadMode;
  status: ThreadStatus;
  sandboxId: string | null;
  /** ISO times, or null. */
  idleSince: string | null;
  runningSince: string | null;
  lastHeartbeatAt: string | null;
}

export type SweepVerdict = { action: "skip" } | { action: "pause"; endReason: EndReason } | { action: "ask_policy" };

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** What the sweep should do with one thread, before asking the usage policy. */
export function sweepVerdict(t: SweepThread, nowMs: number): SweepVerdict {
  const runningSince = ms(t.runningSince);
  if (t.mode !== "cloud" || !t.sandboxId || runningSince === null) return { action: "skip" };

  // The runner says the agent is finished or broken, but the sandbox still runs.
  if (t.status === "failed") return { action: "pause", endReason: "error" };
  if (t.status === "paused" || t.status === "stopped") return { action: "pause", endReason: "idle" };

  const idleSince = ms(t.idleSince);
  if (t.status === "idle" && idleSince !== null && nowMs - idleSince >= IDLE_PAUSE_AFTER_MS) {
    return { action: "pause", endReason: "idle" };
  }

  const lastSeen = Math.max(runningSince, ms(t.lastHeartbeatAt) ?? 0);
  if (nowMs - lastSeen >= RUNNER_SILENCE_PAUSE_MS) return { action: "pause", endReason: "error" };

  return { action: "ask_policy" };
}

export interface SweepDecision<T extends SweepThread> {
  pause: Array<{ thread: T; endReason: EndReason; reason?: string }>;
  keep: T[];
  /** Threads whose policy check threw; left running and retried next sweep. */
  errors: Array<{ thread: T; error: string }>;
}

/**
 * Decide which running sandboxes to pause: idle ones, ones whose runner went
 * silent, and ones the usage policy no longer allows. Pure apart from the
 * policy callback, and safe to run repeatedly.
 */
export async function decideSweep<T extends SweepThread>(
  threads: readonly T[],
  nowMs: number,
  canKeepRunning: (thread: T) => Promise<PolicyDecision>,
): Promise<SweepDecision<T>> {
  const result: SweepDecision<T> = { pause: [], keep: [], errors: [] };
  const toCheck: T[] = [];
  for (const thread of threads) {
    const v = sweepVerdict(thread, nowMs);
    if (v.action === "pause") result.pause.push({ thread, endReason: v.endReason });
    else if (v.action === "ask_policy") toCheck.push(thread);
  }
  const decisions = await Promise.allSettled(toCheck.map(t => canKeepRunning(t)));
  decisions.forEach((d, i) => {
    const thread = toCheck[i]!;
    if (d.status === "rejected") result.errors.push({ thread, error: String(d.reason) });
    else if (d.value.allow) result.keep.push(thread);
    else result.pause.push({ thread, endReason: "policy", reason: d.value.reason });
  });
  return result;
}

/** Whole seconds between a run's start and `endMs`, never negative. */
export function runtimeSeconds(startedAtIso: string, endMs: number): number {
  const start = Date.parse(startedAtIso);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.floor((endMs - start) / 1000));
}
