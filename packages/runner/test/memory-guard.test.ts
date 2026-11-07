import { describe, expect, it } from "vitest";
import { descendants, listProcesses, MemoryGuard, type Proc } from "../src/index.ts";

const MB = 1024 * 1024;
const p = (pid: number, ppid: number, mb: number, name = `p${pid}`): Proc => ({ pid, ppid, rss: mb * MB, name });

describe("memory guard", () => {
  it("counts only what the runner started, however deep", () => {
    const procs = [p(1, 0, 10), p(100, 1, 50, "runner"), p(101, 100, 200, "claude"), p(102, 101, 300, "node"), p(103, 102, 5), p(200, 1, 999, "browser")];
    expect(
      descendants(procs, 100)
        .map(x => x.pid)
        .sort(),
    ).toEqual([101, 102, 103]);
  });

  it("stops the turn first, then the biggest program if memory stays high", async () => {
    let procs = [p(100, 1, 50), p(101, 100, 200, "claude"), p(102, 101, 900, "node")];
    const events: string[] = [];
    const guard = new MemoryGuard({
      rootPid: 100,
      limitBytes: 1000 * MB,
      list: async () => procs,
      kill: (pid, sig) => void events.push(`kill ${pid} ${sig}`),
      onOver: ({ usedBytes, biggest }) => void events.push(`over ${usedBytes / MB} ${biggest?.name}`),
      onKilled: x => void events.push(`killed ${x.name}`),
    });
    await guard.check();
    expect(events).toEqual(["over 1100 node"]);
    await guard.check(); // still over after the turn stopped
    expect(events.slice(1)).toEqual(["kill 102 SIGTERM", "killed node"]);
    procs = [p(100, 1, 50), p(101, 100, 200, "claude")];
    await guard.check();
    procs = [p(100, 1, 50), p(101, 100, 1200, "claude")];
    await guard.check(); // a new episode warns again before killing anything
    expect(events.at(-1)).toBe("over 1200 claude");
  });

  it("reads real processes on this machine", async () => {
    const procs = await listProcesses();
    if (process.platform === "win32") return expect(procs).toBeNull();
    expect(procs!.some(x => x.pid === process.pid && x.rss > 0)).toBe(true);
  });
});
