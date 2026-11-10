import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, deriveAgentKey, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

// The agent gets a key derived from the thread secret, never the secret. These pin down
// what each key can and can't do on the runner.
const SECRET = "thread-secret-for-agent-key-tests-01";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };

async function boot() {
  const now = new Date().toISOString();
  const thread: Thread = {
    id: "agent-key-thread-1",
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread("agent-key-thread-1"),
    mode: "cloud",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return { thread, port: server.port };
}

const token = (key: string, scope: "client" | "runner", seconds = 60) =>
  signToken({ threadId: "agent-key-thread-1", scope, exp: Math.floor(Date.now() / 1000) + seconds }, key);

function hello(port: number, t: string): Promise<string> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: t, resumeFrom: 0 })));
    ws.on("message", raw => {
      const m = JSON.parse(raw.toString()) as { type: string };
      if (m.type === "welcome" || m.type === "error") {
        ws.close();
        resolve(m.type);
      }
    });
  });
}

describe("the agent key", () => {
  it("can't be turned into the secret and differs per thread", async () => {
    const key = await deriveAgentKey(SECRET);
    expect(key).not.toContain(SECRET);
    expect(key).not.toBe(await deriveAgentKey("another-thread-secret-0123456789"));
    expect(await deriveAgentKey(SECRET)).toBe(key);
  });

  it("works for the agent's tools, but the thread secret no longer does", async () => {
    const { port } = await boot();
    const key = await deriveAgentKey(SECRET);
    const offer = (t: string) =>
      fetch(`http://127.0.0.1:${port}/previews`, {
        method: "POST",
        headers: { authorization: `Bearer ${t}` },
        body: JSON.stringify({ port: 5173, name: "web" }),
      });
    expect((await offer(await token(key, "runner"))).status).toBe(200);
    expect((await offer(await token(SECRET, "runner"))).status).toBe(401);
    const list = (t: string) => fetch(`http://127.0.0.1:${port}/subagents`, { headers: { authorization: `Bearer ${t}` } });
    expect((await list(await token(key, "runner"))).status).toBe(200);
    expect((await list(await token(SECRET, "runner"))).status).toBe(401);
  });

  it("can't open the user's connection, which still needs the secret", async () => {
    const { port } = await boot();
    const key = await deriveAgentKey(SECRET);
    expect(await hello(port, await token(key, "client"))).toBe("error");
    expect(await hello(port, await token(SECRET, "client"))).toBe("welcome");
  });

  it("refuses tokens that claim to live far longer than any app makes them", async () => {
    const { port } = await boot();
    expect(await hello(port, await token(SECRET, "client", 365 * 24 * 3600))).toBe("error");
    expect(await hello(port, await token(SECRET, "client", 15 * 60))).toBe("welcome");
  });
});
