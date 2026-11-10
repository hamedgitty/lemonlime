import { describe, expect, it } from "vitest";
import { RUNNER_STATUSES, RunnerHeartbeat } from "../src/index.ts";

describe("runner heartbeats", () => {
  const beat = { threadId: "thread-0123456789", latestSeq: 4, idleSince: null, runnerVersion: "1.0.0" };

  it("carry the statuses a runner reports about itself", () => {
    expect(RUNNER_STATUSES).toEqual(["provisioning", "idle", "running"]);
    for (const status of RUNNER_STATUSES) expect(RunnerHeartbeat.safeParse({ ...beat, status }).success).toBe(true);
  });

  it("can't say a thread is paused, stopped or failed: the control plane decides those", () => {
    for (const status of ["paused", "stopped", "failed", "finished"]) {
      const parsed = RunnerHeartbeat.safeParse({ ...beat, status });
      expect(parsed.success).toBe(false);
    }
    expect(RunnerHeartbeat.safeParse({ ...beat, status: "stopped" }).error?.issues[0]?.message).toBe("A runner can't report that status.");
  });
});
