import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";
import { serveKeys } from "../src/keeper.ts";
import { keysFromKeeper, keysFromSecret, type ThreadKeys } from "../src/keys.ts";

// Nobody here has signed in. Whatever they send, the runner refuses it and keeps serving.

const SECRET = "thread-secret-for-tests-0123456789";
const THREAD = "bad-requests-1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(keys?: ThreadKeys) {
  const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
  const now = new Date().toISOString();
  const thread: Thread = {
    id: THREAD,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(THREAD),
    mode: "cloud",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, version: "t", ...(keys ? { keys } : { threadSecret: SECRET }) });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return { runner, port: server.port };
}

async function keeperKeys(): Promise<ThreadKeys> {
  const socket = join(mkdtempSync(join(tmpdir(), "bad-requests-")), "k.sock");
  const server = await serveKeys(socket, await keysFromSecret(THREAD, SECRET));
  cleanups.push(() => new Promise(r => server.close(r)));
  return keysFromKeeper(socket);
}

/** Open a socket, send what `first` returns, and wait for it to close: the close code and what arrived first. */
function attempt(url: string, first: (ws: WebSocket) => void): Promise<{ code: number; messages: string[] }> {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    cleanups.push(() => ws.terminate());
    ws.on("open", () => first(ws));
    ws.on("message", m => messages.push(m.toString()));
    ws.on("error", () => {});
    ws.on("close", code => resolve({ code, messages }));
  });
}

/** The thread still answers, to someone who is allowed in. */
async function stillServing(port: number): Promise<void> {
  const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ok: boolean };
  expect(health.ok).toBe(true);
  const token = await signToken({ threadId: THREAD, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const welcome = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.terminate());
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, resumeFrom: 0 })));
    ws.on("message", m => resolve(m.toString()));
    ws.on("error", reject);
  });
  expect(JSON.parse(welcome)).toMatchObject({ type: "welcome" });
}

describe("requests from someone who hasn't signed in", () => {
  it("an address that can't be read gets a 400, or no connection", async () => {
    const { port } = await boot();
    for (const path of ["//", "//x:99999/"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(400);
    }
    expect((await attempt(`ws://127.0.0.1:${port}//`, () => {})).code).toBe(1006);
    await stillServing(port);
  });

  it("a frame that is too big ends that connection only", async () => {
    const { port } = await boot();
    await attempt(`ws://127.0.0.1:${port}/terminal`, ws => ws.send("x".repeat(300 * 1024)));
    await attempt(`ws://127.0.0.1:${port}/tunnel?port=1`, ws => ws.send(Buffer.alloc(1024 * 1024 + 1024)));
    await attempt(`ws://127.0.0.1:${port}/ws`, ws => ws.send("x".repeat(1024 * 1024 + 1024)));
    await stillServing(port);
  });

  it("a preview connection whose token isn't text is refused", async () => {
    const { port } = await boot();
    for (const hello of ['{"type":"hello","token":5}', '{"type":"hello","token":{"length":3}}', '{"type":"hello"}', "null", "not json"]) {
      expect((await attempt(`ws://127.0.0.1:${port}/tunnel?port=1`, ws => ws.send(hello))).code).toBe(4401);
    }
    await stillServing(port);
  });

  it("a token far too long to be one is refused, with a keeper too", async () => {
    const keys = await keeperKeys();
    expect(await keys.verify("a".repeat(5000))).toMatchObject({ ok: false });
    expect(await keys.verify(5 as unknown as string)).toMatchObject({ ok: false });

    const { port } = await boot(keys);
    const hello = JSON.stringify({ type: "hello", token: "a".repeat(5000), resumeFrom: 0, cols: 80, rows: 24 });
    expect((await attempt(`ws://127.0.0.1:${port}/tunnel?port=1`, ws => ws.send(hello))).code).toBe(4401);
    for (const path of ["/ws", "/terminal"]) {
      const got = await attempt(`ws://127.0.0.1:${port}${path}`, ws => {
        ws.send(hello);
        // The hello is not accepted, so this counts as talking before signing in.
        ws.send(JSON.stringify({ type: "ping" }));
        setTimeout(() => ws.close(), 200);
      });
      expect(got.messages.join("\n")).not.toContain("welcome");
      expect(got.messages.join("\n")).toContain("error");
    }
    await stillServing(port);
  });

  it("a token check that fails for any reason is a refusal, not a crash", async () => {
    const real = await keysFromSecret(THREAD, SECRET);
    let broken = true;
    const keys: ThreadKeys = {
      ...real,
      verify: token => (broken ? Promise.reject(new Error("the keeper didn't answer")) : real.verify(token)),
    };
    const { port } = await boot(keys);
    const token = await signToken({ threadId: THREAD, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const hello = JSON.stringify({ type: "hello", token, resumeFrom: 0, cols: 80, rows: 24 });
    for (const path of ["/ws", "/terminal", "/tunnel?port=1"]) {
      expect((await attempt(`ws://127.0.0.1:${port}${path}`, ws => ws.send(hello))).code).toBe(4401);
    }
    broken = false;
    await stillServing(port);
  });

  it("a preview connection can't pile up data while its token is checked", async () => {
    const real = await keysFromSecret(THREAD, SECRET);
    let answer: () => void = () => {};
    const waiting = new Promise<void>(r => (answer = r));
    cleanups.push(answer);
    const keys: ThreadKeys = { ...real, verify: async token => (await waiting, real.verify(token)) };
    const { port } = await boot(keys);
    const got = await attempt(`ws://127.0.0.1:${port}/tunnel?port=1`, ws => {
      ws.send(JSON.stringify({ type: "hello", token: "not-checked-yet" }));
      for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(512 * 1024));
    });
    expect(got.code).toBe(1009);
  });
});
