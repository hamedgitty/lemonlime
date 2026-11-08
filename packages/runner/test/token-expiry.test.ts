import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const SECRET = "thread-secret-for-expiry-tests-0123";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot() {
  const now = new Date().toISOString();
  const thread: Thread = {
    id: "expiry-thread-1",
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread("expiry-thread-1"),
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
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return server.port;
}

const tokenFor = (seconds: number) => signToken({ threadId: "expiry-thread-1", scope: "client", exp: Math.floor(Date.now() / 1000) + seconds }, SECRET);

describe("connections end with their token", () => {
  it("closes when the token runs out, and the app reconnects at once with a fresh one", async () => {
    const port = await boot();
    let tokens = 0;
    const states: string[] = [];
    let welcomes = 0;
    const client = new RunnerClient({
      url: `ws://127.0.0.1:${port}/ws`,
      // Each token lasts a second or two.
      token: () => (tokens++, tokenFor(2)),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onState: s => states.push(s),
      onWelcome: () => welcomes++,
    });
    client.connect();
    cleanups.push(() => client.close());
    await new Promise(r => setTimeout(r, 4500));
    expect(welcomes).toBeGreaterThanOrEqual(2);
    expect(tokens).toBeGreaterThanOrEqual(2);
    // A planned close never shows the thread as reconnecting.
    expect(states).not.toContain("reconnecting");
  });

  it("without a fresh token (say, removed from the workspace), stays out", async () => {
    const port = await boot();
    const closed = await new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("open", async () => ws.send(JSON.stringify({ type: "hello", token: await tokenFor(1), resumeFrom: 0 })));
      ws.on("close", code => resolve(code));
    });
    expect(closed).toBe(4001);
  });
});
