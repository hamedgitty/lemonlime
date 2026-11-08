import { describe, expect, it } from "vitest";
import { runLineProcess } from "../src/agents/index.ts";
import { GROUPS, killAllAgentGroups } from "../src/agents/process.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  return check();
};

// A fake agent that starts a background job (like a dev server or a build) and reports its pid.
// Its output goes elsewhere, as an agent's tool shells do, so it doesn't hold the agent's stdout open.
const agentWithJob = (afterJob: string) => `sleep 300 >/dev/null 2>&1 & echo "{\\"job\\": $!}"; ${afterJob}`;

describe.skipIf(!GROUPS)("agent process groups", () => {
  it("stopping an agent also stops what it started", async () => {
    const abort = new AbortController();
    let job = 0;
    const done = runLineProcess({
      command: "sh",
      args: ["-c", agentWithJob("wait")],
      cwd: process.cwd(),
      signal: abort.signal,
      onLine: line => {
        job = (JSON.parse(line) as { job: number }).job;
        abort.abort();
      },
    });
    await done;
    expect(job).toBeGreaterThan(0);
    expect(await waitFor(() => !alive(job))).toBe(true);
  });

  it("a finished turn leaves its background jobs running until the runner exits", async () => {
    let job = 0;
    await runLineProcess({
      command: "sh",
      args: ["-c", agentWithJob("exit 0")],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onLine: line => (job = (JSON.parse(line) as { job: number }).job),
    });
    // A dev server the agent started for a preview must outlive the turn.
    expect(alive(job)).toBe(true);
    killAllAgentGroups();
    expect(await waitFor(() => !alive(job))).toBe(true);
  });
});
