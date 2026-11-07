import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, parseTerminalServerMessage, signToken, type TerminalServerMessage, type Thread } from "@lemonlime/protocol";
import { TerminalClient } from "@lemonlime/client";
import { loadPty, shellEnv, startServer, TerminalSession, ThreadRunner, type AgentAdapter, type Pty } from "../src/index.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };

function thread(id: string): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "local",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function boot(spawn: Awaited<ReturnType<typeof loadPty>>) {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-term-"));
  const runner = new ThreadRunner({
    thread: thread("term-thread-1"),
    workdir: dir,
    dataDir: null,
    adapter: idle,
    session: { autonomy: "full" },
    git: false,
    bundledSkills: false,
  });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t", terminal: { cwd: dir, spawn } });
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => runner.close(),
    () => server.close(),
  );
  return server.port;
}

function open(port: number, hello: { resumeFrom?: number; shell?: number; token?: string } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`);
  const got: TerminalServerMessage[] = [];
  let text = "";
  ws.on("message", raw => {
    const m = parseTerminalServerMessage(raw.toString())!;
    got.push(m);
    if (m.type === "output") text += m.data;
  });
  const ready = new Promise<void>(resolve =>
    ws.on("open", async () => {
      const token = hello.token ?? (await signToken({ threadId: "term-thread-1", scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET));
      ws.send(JSON.stringify({ type: "hello", token, cols: 80, rows: 24, ...hello, ...(hello.token ? {} : {}) }));
      resolve();
    }),
  );
  cleanups.push(() => ws.close());
  return { ws, got, text: () => text, ready, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 20));
  }
};

describe("thread terminal", () => {
  it("runs a real shell in the thread's folder, and picks up where a client left off", async () => {
    const spawn = await loadPty();
    if (!spawn || process.platform === "win32") return; // no prebuilt PTY here
    const port = await boot(spawn);
    const a = open(port);
    await a.ready;
    await until(() => a.got.some(m => m.type === "ready"));
    a.send({ type: "input", data: "echo marker-$((40+2)); pwd\r" });
    await until(() => a.text().includes("marker-42"));
    expect(a.text()).toContain("lemonlime-term-");
    const last = [...a.got].reverse().find(m => m.type === "output") as Extract<TerminalServerMessage, { type: "output" }>;
    const shell = (a.got.find(m => m.type === "ready") as Extract<TerminalServerMessage, { type: "ready" }>).shell;
    a.ws.close();

    // The shell kept running; resuming sends only what came after.
    const b = open(port, { resumeFrom: last.end, shell });
    await b.ready;
    await until(() => b.got.some(m => m.type === "ready"));
    expect(b.got[0]).toMatchObject({ type: "ready", reset: false, running: true });
    expect(b.text()).not.toContain("marker-42");
    b.send({ type: "input", data: "echo again\r" });
    await until(() => b.text().includes("again"));

    // A client with nothing (or a stale position) gets the whole screen history again.
    const c = open(port, { resumeFrom: 999_999_999, shell });
    await c.ready;
    await until(() => c.text().includes("marker-42"));
    expect(c.got[0]).toMatchObject({ type: "ready", reset: true });
  });

  it("the app's client resumes after a dropped connection without repeating output", async () => {
    const spawn = await loadPty();
    if (!spawn || process.platform === "win32") return;
    const port = await boot(spawn);
    let screen = "";
    let resets = 0;
    const states: string[] = [];
    const client = new TerminalClient({
      url: `ws://127.0.0.1:${port}/terminal`,
      token: () => signToken({ threadId: "term-thread-1", scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET),
      cols: 80,
      rows: 24,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onData: d => (screen += d),
      onReset: () => resets++,
      onState: s => states.push(s),
      maxBackoffMs: 50,
    });
    cleanups.push(() => client.close());
    client.connect();
    await until(() => states.includes("live"));
    client.write("echo first-$((1+1))\r");
    await until(() => screen.includes("first-2"));
    (client as unknown as { ws: WebSocket }).ws.close(); // the network drops
    await until(() => states.filter(s => s === "live").length === 2);
    client.write("echo second-$((2+2))\r");
    await until(() => screen.includes("second-4"));
    // The command's output appears once: nothing was replayed twice.
    expect(screen.split("first-2").length - 1).toBe(1);
    expect(resets).toBe(1); // only the very first connect started from scratch
  });

  it("refuses runner tokens and bad tokens", async () => {
    const port = await boot(null);
    const runnerToken = await signToken({ threadId: "term-thread-1", scope: "runner", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const a = open(port, { token: runnerToken });
    await a.ready;
    await until(() => a.got.length > 0);
    expect(a.got[0]).toMatchObject({ type: "error", code: "unauthorized" });
    // Authorized, but no PTY on this machine: says so.
    const b = open(port);
    await b.ready;
    await until(() => b.got.length > 0);
    expect(b.got[0]).toMatchObject({ type: "error", code: "unavailable" });
  });

  it("keeps only the last megabyte, and hides the runner's own secrets from the shell", () => {
    let emit: (d: string) => void = () => {};
    const fake: Pty = { onData: cb => ((emit = cb), { dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} };
    const t = new TerminalSession(() => fake, "/tmp", "/bin/sh");
    t.start();
    for (let i = 0; i < 40; i++) emit("x".repeat(64 * 1024));
    expect(t.end).toBe(40 * 64 * 1024);
    expect(t.replay(0, t.generation).reset).toBe(true);
    expect(t.replay(undefined).data.length).toBeLessThanOrEqual(1024 * 1024);
    expect(t.replay(t.end - 10, t.generation)).toEqual({ reset: false, data: "x".repeat(10) });
    expect(t.replay(t.end - 10, t.generation + 1).reset).toBe(true); // a position from another shell

    const env = shellEnv({ PATH: "/bin", LEMONLIME_THREAD_SECRET: "s", LEMONLIME_APPROVAL_TOKEN: "a", HOME: "/h" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", TERM: "xterm-256color" });
    expect(env.LEMONLIME_THREAD_SECRET).toBeUndefined();
    expect(env.LEMONLIME_APPROVAL_TOKEN).toBeUndefined();
  });
});
