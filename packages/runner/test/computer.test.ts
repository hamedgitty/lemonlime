import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { branchForThread, signToken, type ComputerRequest, type Thread, deriveAgentKey } from "@lemonlime/protocol";
import { runSubagentTool, startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("computer access", () => {
  it("passes a cloud agent's request to the desktop app and its answer back", async () => {
    const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "computer-thread-1",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread("computer-thread-1"),
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
    const env = {
      LEMONLIME_RUNNER_URL: `http://127.0.0.1:${server.port}`,
      LEMONLIME_THREAD_ID: thread.id,
      LEMONLIME_AGENT_KEY: await deriveAgentKey(SECRET),
      LEMONLIME_COMPUTER_TOOLS: "1",
    };

    // No desktop app connected yet.
    const alone = await runSubagentTool("computer_read_file", { path: "/Users/me/notes.txt" }, env);
    expect(alone).toMatchObject({ isError: true });
    expect(alone.content[0]!.text).toMatch(/desktop app isn't open/);

    const seen: ComputerRequest[] = [];
    let live = false;
    const desktop: RunnerClient = new RunnerClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: () => signToken({ threadId: thread.id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onState: s => (live = s === "live"),
      onComputerRequest: (id, req) => {
        seen.push(req);
        desktop.computerResult(id, req.op === "read_file", req.op === "read_file" ? "hello from the user's mac" : "Not allowed: this thread can only read.");
      },
    });
    cleanups.push(() => desktop.close());
    desktop.connect();
    while (!live) await new Promise(r => setTimeout(r, 10));

    const read = await runSubagentTool("computer_read_file", { path: "/Users/me/notes.txt" }, env);
    expect(read.content[0]!.text).toBe("hello from the user's mac");
    const ran = await runSubagentTool("computer_run_command", { command: "ls ~" }, env);
    expect(ran).toMatchObject({ isError: true, content: [{ text: "Not allowed: this thread can only read." }] });
    expect(seen).toEqual([
      { op: "read_file", path: "/Users/me/notes.txt" },
      { op: "run_command", command: "ls ~" },
    ]);
    // Agents in local threads (no LEMONLIME_COMPUTER_TOOLS) don't get the tools at all.
    expect(await runSubagentTool("computer_read_file", { path: "/x" }, { ...env, LEMONLIME_COMPUTER_TOOLS: "" })).toMatchObject({ isError: true });
  });
});
