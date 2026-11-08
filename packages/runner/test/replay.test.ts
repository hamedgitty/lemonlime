import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const SECRET = "thread-secret-for-replay-tests-0123";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("history replay", () => {
  it("sends a long history whole and in order, in steps", async () => {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "replay-thread-1",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread("replay-thread-1"),
      mode: "local",
      status: "idle",
      sandboxSize: "small",
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
    const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
    await runner.init();
    // About 6 MB of history: several times the replay's high-water mark.
    const big = "x".repeat(3000);
    const before = runner.store.latestSeq;
    for (let i = 0; i < 2000; i++) runner.store.append({ type: "agent_message", text: `${i} ${big}` });
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    cleanups.push(
      () => runner.close(),
      () => server.close(),
    );
    const token = await signToken({ threadId: thread.id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const seqs: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, resumeFrom: 0 })));
      ws.on("message", raw => {
        const m = JSON.parse(raw.toString()) as { type: string; event?: { seq: number } };
        if (m.type === "event") seqs.push(m.event!.seq);
        if (m.type === "caught_up") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
    expect(seqs.length).toBe(before + 2000);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });
});
