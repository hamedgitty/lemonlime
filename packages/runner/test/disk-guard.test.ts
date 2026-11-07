import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { diskSpace, DiskGuard, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const GB = 1024 ** 3;

describe("disk guard", () => {
  it("warns, pauses below 5%, and carries on at 8%", async () => {
    let free = 50;
    let now = 0;
    const seen: string[] = [];
    const guard = new DiskGuard({
      path: "/",
      read: async () => ({ freeBytes: (free / 10) * GB, totalBytes: 10 * GB }), // a sandbox-sized disk
      now: () => now,
      onWarn: () => void seen.push("warn"),
      onPause: () => void seen.push("pause"),
      onResume: () => void seen.push("resume"),
      onStillFull: () => void seen.push("still full"),
    });
    await guard.check();
    free = 12;
    await guard.check();
    await guard.check(); // warned once
    free = 4;
    await guard.check();
    expect(guard.paused).toBe(true);
    free = 6; // over 5% but under 8%: stays paused
    await guard.check();
    free = 4;
    now = 31_000;
    await guard.check();
    await guard.check();
    free = 9;
    await guard.check();
    expect(seen).toEqual(["warn", "pause", "still full", "resume"]);
    expect(guard.paused).toBe(false);
  });

  it("doesn't count a big disk with gigabytes left as full", async () => {
    const seen: string[] = [];
    let free = 18.9; // GB free of 460: 4%, but plenty
    const guard = new DiskGuard({
      path: "/",
      read: async () => ({ freeBytes: free * GB, totalBytes: 460 * GB }),
      onWarn: () => void seen.push("warn"),
      onPause: () => void seen.push("pause"),
      onResume: () => void seen.push("resume"),
    });
    await guard.check();
    expect(seen).toEqual([]);
    free = 1.5;
    await guard.check();
    expect(seen).toEqual(["pause"]);
    free = 5;
    await guard.check();
    expect(seen).toEqual(["pause", "resume"]);
  });

  it("reads this machine's disk", async () => {
    const s = await diskSpace(tmpdir());
    expect(s!.totalBytes).toBeGreaterThan(s!.freeBytes);
  });

  it("a held runner keeps messages waiting until it's released", async () => {
    const prompts: string[] = [];
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({ runTurn: async ctx => void prompts.push(ctx.prompt), saveState: () => ({}), dispose: async () => {} }),
    };
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "disk-thread-1",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread("disk-thread-1"),
      mode: "local",
      status: "idle",
      sandboxSize: "small",
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    const runner = new ThreadRunner({ thread, workdir: tmpdir(), dataDir: null, adapter, session: { autonomy: "full" }, git: false, bundledSkills: false });
    await runner.init();
    runner.hold("disk_full");
    expect(runner.sendMessage("while full").result).toBe("queued");
    await new Promise(r => setTimeout(r, 30));
    expect(prompts).toEqual([]);
    runner.release();
    await runner.settled();
    await new Promise(r => setTimeout(r, 30));
    await runner.settled();
    expect(prompts).toEqual(["while full"]);
    await runner.close();
  });
});
