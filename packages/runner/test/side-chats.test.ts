import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { branchForThread, signToken, type SideChatSummary, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter, type Autonomy } from "../src/index.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 10));
  }
};

describe("side chats", () => {
  it("answer from a read-only agent with the thread as context, and stay out of the thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-side-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const seen: { autonomy: Autonomy; prompt: string }[] = [];
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: opts => ({
        runTurn: async ctx => {
          seen.push({ autonomy: opts.autonomy, prompt: ctx.prompt });
          ctx.emit({ type: "agent_message", text: opts.autonomy === "read" ? "It changed parser.ts." : "Fixed the parser." });
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "side-thread-1",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread("side-thread-1"),
      mode: "local",
      status: "idle",
      sandboxSize: "small",
      latestSeq: 0,
      mine: true,
      shared: false,
      createdAt: now,
      updatedAt: now,
    };
    const runner = new ThreadRunner({
      thread,
      workdir: dir,
      dataDir: join(dir, ".data"),
      adapter,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
    });
    await runner.init();
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    cleanups.push(
      () => runner.close(),
      () => server.close(),
    );
    runner.sendMessage("fix the parser");
    await runner.settled();
    const before = runner.store.latestSeq;

    let chats: SideChatSummary[] = [];
    let started = "";
    const sideEvents: ThreadEvent[] = [];
    const client = new RunnerClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: () => signToken({ threadId: thread.id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onSideChats: c => (chats = c),
      onSideStarted: id => (started = id),
      onSideEvent: (_id, e) => sideEvents.push(e),
    });
    cleanups.push(() => client.close());
    client.connect();
    client.sideAsk("which file did you change?");
    await until(() => sideEvents.some(e => e.type === "agent_message"));

    expect(seen[1]!.autonomy).toBe("read");
    expect(seen[1]!.prompt).toContain("don't change anything");
    expect(seen[1]!.prompt).toContain("User: fix the parser");
    expect(seen[1]!.prompt.endsWith("which file did you change?")).toBe(true);
    expect(runner.store.latestSeq).toBe(before); // nothing in the thread's history
    await until(() => chats.length === 1 && !chats[0]!.busy);
    expect(chats[0]).toMatchObject({ id: started, title: "which file did you change?", pinned: false });

    // Pinned chats are kept on disk; closing an unpinned one discards it.
    client.sidePin(started, true);
    await until(() => existsSync(join(dir, ".data", "side-chats", `${started}.json`)));
    client.sidePin(started, false);
    await until(() => !existsSync(join(dir, ".data", "side-chats", `${started}.json`)));
    client.sideClose(started);
    await until(() => chats.length === 0);
  });
});
