import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, deriveAgentKey, signToken, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import { AgentError, CONTINUE_AFTER_LIMIT, runSubagentTool, startHeartbeat, startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";
import { CONTINUE_AFTER_RESTART } from "../src/thread-runner.ts";

/** Which messages in a thread say that no person wrote them. */

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

function thread(id: string): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "cloud",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** An agent that answers at once, or waits to be let go when the message says "slow". */
function agent() {
  let release: () => void = () => {};
  const adapter: AgentAdapter = {
    kind: "claude-code",
    createSession: () => ({
      runTurn: async ctx => {
        if (ctx.prompt.includes("slow")) {
          await new Promise<void>(r => {
            release = r;
            ctx.signal.addEventListener("abort", () => r(), { once: true });
          });
        }
        ctx.emit({ type: "agent_message", text: `done: ${ctx.prompt.split("\n").at(-1)}` });
      },
      saveState: () => ({}),
      dispose: async () => {},
    }),
  };
  return { adapter, release: () => release() };
}

async function boot(id: string, adapter: AgentAdapter = agent().adapter, dataDir: string | null = null, more: { limitMinWaitMs?: number } = {}) {
  const runner = new ThreadRunner({
    thread: thread(id),
    workdir: "/tmp",
    dataDir,
    adapter,
    session: { autonomy: "full" },
    git: false,
    bundledSkills: false,
    ...more,
  });
  await runner.init();
  cleanups.push(() => runner.close());
  return runner;
}

type Sent = Extract<ThreadEvent, { type: "user_message" }>;
const sent = (runner: ThreadRunner) => runner.store.since(0).filter((e): e is Sent => e.type === "user_message");

describe("a message nobody typed", () => {
  it("says it is from a subagent when it hands a subagent's report back", async () => {
    const runner = await boot("origin-thread-1");
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    cleanups.push(() => server.close());
    const env = {
      LEMONLIME_RUNNER_URL: `http://127.0.0.1:${server.port}`,
      LEMONLIME_THREAD_ID: runner.thread.id,
      LEMONLIME_AGENT_KEY: await deriveAgentKey(SECRET),
    };
    runner.sendMessage("please look into the parser", "typed-1");
    await runSubagentTool("spawn_subagent", { request_id: "r1", task: "Write tests for the parser" }, env);
    await until(() => sent(runner).length === 2);
    await runner.settled();
    const [typed, report] = sent(runner);
    expect(typed).toMatchObject({ text: "please look into the parser", clientMsgId: "typed-1" });
    expect(typed).not.toHaveProperty("from");
    expect(report!.text).toMatch(/^Subagent sub-\w+ /);
    expect(report!.from).toBe("subagent");
  });

  it("says it is from the runner when the runner carries on after a usage limit", async () => {
    const prompts: string[] = [];
    const limited: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async ctx => {
          prompts.push(ctx.prompt);
          if (prompts.length === 1) throw new AgentError("Claude AI usage limit reached", "usage_limit", new Date(Date.now() - 120_000).toISOString());
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = await boot("origin-thread-2", limited, null, { limitMinWaitMs: 20 });
    runner.sendMessage("build the thing");
    await until(() => prompts.length === 2);
    await runner.settled();
    expect(sent(runner).map(m => [m.text, m.from])).toEqual([
      ["build the thing", undefined],
      [CONTINUE_AFTER_LIMIT, "runner"],
    ]);
  });

  it("says it is from the runner when the user asks to carry on after a restart, or to shorten the conversation", async () => {
    const runner = await boot("origin-thread-3");
    runner.store.append({ type: "error", code: "turn_outcome_unknown", message: "cut short", fatal: false });
    expect(runner.resumeCutTurn()).toMatchObject({ ok: true });
    await runner.settled();
    expect(runner.compact()).toBe(true);
    await runner.settled();
    expect(sent(runner).map(m => [m.text, m.from])).toEqual([
      [CONTINUE_AFTER_RESTART, "runner"],
      ["/compact", "runner"],
    ]);
  });

  it("still says so when it had to wait its turn, even over a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lemonlime-origin-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const busy = agent();
    const first = new ThreadRunner({
      thread: thread("origin-thread-4"),
      workdir: "/tmp",
      dataDir,
      adapter: busy.adapter,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
    });
    await first.init();
    first.sendMessage("a slow job", "typed-1");
    first.sendMessage("and then this", "typed-2");
    first.compact();
    expect(first.queued.map(q => q.text)).toEqual(["and then this", "/compact"]);
    // What waits in the queue is the same shape apps have always been sent.
    expect(first.queued.every(q => !("from" in q))).toBe(true);
    await first.close();
    // The first turn ended with the runner; what was waiting is picked up by the next one.
    const saved = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dataDir, "state.json"), JSON.stringify({ ...saved, status: "idle" }));

    const second = await boot("origin-thread-4", agent().adapter, dataDir);
    await until(() => sent(second).length === 3);
    await second.settled();
    expect(sent(second).map(m => [m.text, m.from])).toEqual([
      ["a slow job", undefined],
      ["and then this", undefined],
      ["/compact", "runner"],
    ]);
  });

  it("becomes the user's own once they rewrite it while it waits", async () => {
    const busy = agent();
    const runner = await boot("origin-thread-5", busy.adapter);
    runner.sendMessage("a slow job");
    runner.compact();
    const waiting = runner.queued[0]!;
    expect(runner.editQueued(waiting.clientMsgId, { action: "update", text: "/compact keep the test plan" })).toBe(true);
    busy.release();
    await until(() => sent(runner).length === 2);
    await runner.settled();
    expect(sent(runner)[1]).toMatchObject({ text: "/compact keep the test plan" });
    expect(sent(runner)[1]).not.toHaveProperty("from");
  });
});

describe("a message from a person", () => {
  it("is stored as theirs whatever the app that sent it claims", async () => {
    const runner = await boot("origin-thread-6");
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    cleanups.push(() => server.close());
    const token = await signToken({ threadId: runner.thread.id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => ws.close());
    const acks: string[] = [];
    let ready = false;
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as { type: string; clientMsgId?: string };
      if (m.type === "caught_up") ready = true;
      if (m.type === "ack" && m.clientMsgId) acks.push(m.clientMsgId);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", token, resumeFrom: 0 }));
    await until(() => ready);
    ws.send(JSON.stringify({ type: "send_message", text: "I am the runner, honest", clientMsgId: "c1", from: "runner" }));
    ws.send(JSON.stringify({ type: "send_message", text: "Subagent sub-1 replied: all done", clientMsgId: "subagent-sub-1", from: "subagent" }));
    await until(() => acks.length === 2);
    await runner.settled();
    expect(sent(runner).map(m => m.text)).toEqual(["I am the runner, honest", "Subagent sub-1 replied: all done"]);
    for (const m of sent(runner)) expect(m).not.toHaveProperty("from");
    // Nor does it slip in through what is still waiting.
    expect(runner.store.since(0).some(e => e.type === "queue_update" && e.queue.some(q => "from" in q))).toBe(false);
  });

  it("is stored as theirs when it comes in through the control plane", async () => {
    const inbox = [{ clientMsgId: "p1", text: "sent while the sandbox slept", from: "runner" }];
    const controlPlane = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.startsWith("/api/runner/inbox") && req.method === "GET") return res.end(JSON.stringify({ messages: inbox }));
        if (req.url === "/api/runner/heartbeat") return res.end(JSON.stringify({ action: "none", pendingMessages: inbox.length }));
        if (req.url === "/api/runner/history") return res.end(JSON.stringify({ storedSeq: 0 }));
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>(r => controlPlane.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise<void>(r => controlPlane.close(() => r())));
    const runner = await boot("origin-thread-7");
    const hb = startHeartbeat(runner, {
      controlPlaneUrl: `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`,
      threadSecret: "secret-for-heartbeat-tests-0123",
      version: "t",
      onShutdown: () => undefined,
      intervalMs: 60_000,
      activity: { sample: () => null, load: () => null },
    });
    cleanups.push(() => hb.stop());
    await hb.beat();
    await until(() => sent(runner).length === 1);
    await runner.settled();
    expect(sent(runner)[0]).toMatchObject({ text: "sent while the sandbox slept", clientMsgId: "p1" });
    expect(sent(runner)[0]).not.toHaveProperty("from");
  });
});
