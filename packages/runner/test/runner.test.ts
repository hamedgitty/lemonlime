import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { branchForThread, signToken, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import { acpAdapter, startServer, ThreadRunner, type AgentAdapter, type RunningServer } from "../src/index.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const here = dirname(fileURLToPath(import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-runner-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return dir;
}

function makeThread(id: string): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "local", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "local",
    status: "provisioning",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** A pretend agent that answers and edits a file, without any real CLI. */
const fakeAdapter: AgentAdapter = {
  kind: "claude-code",
  createSession(opts) {
    return {
      async runTurn(ctx) {
        ctx.emit({ type: "tool_call", callId: "c1", name: "write_file", input: { path: "notes.md" } });
        writeFileSync(join(opts.cwd, "notes.md"), `${ctx.prompt}\n`);
        ctx.emit({ type: "tool_result", callId: "c1", output: "ok" });
        ctx.emit({ type: "agent_message", text: `Wrote notes for: ${ctx.prompt}` });
      },
      saveState: () => ({}),
      dispose: async () => {},
    };
  },
};

async function boot(adapter: AgentAdapter, id = "test-thread-1"): Promise<{ runner: ThreadRunner; server: RunningServer; dir: string }> {
  const dir = tempRepo();
  const runner = new ThreadRunner({ thread: makeThread(id), workdir: dir, dataDir: join(dir, ".lemonlime"), adapter, session: { autonomy: "edits" } });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "test" });
  cleanups.push(async () => {
    await runner.close();
    await server.close();
  });
  return { runner, server, dir };
}

const token = (threadId: string, secret = SECRET, scope: "client" | "runner" = "client") =>
  signToken({ threadId, scope, exp: Math.floor(Date.now() / 1000) + 60 }, secret);

function connect(port: number, tok: Promise<string> | string, resumeFrom = 0) {
  const events: ThreadEvent[] = [];
  const errors: string[] = [];
  const states: string[] = [];
  const acks: string[] = [];
  const client = new RunnerClient({
    url: `ws://127.0.0.1:${port}/ws`,
    token: async () => tok,
    resumeFrom,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    onEvent: e => events.push(e),
    onError: m => errors.push(m),
    onState: s => states.push(s),
    onAck: (id, r) => acks.push(`${id}:${r}`),
    maxBackoffMs: 200,
  });
  client.connect();
  cleanups.push(() => client.close());
  return { client, events, errors, states, acks };
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 20));
  }
}

describe("runner end to end", () => {
  it("streams a turn, records the diff and commits on the thread branch", async () => {
    const { runner, server, dir } = await boot(fakeAdapter);
    const c = connect(server.port, token(runner.thread.id));
    await until(() => c.states.includes("live"));
    c.client.send("Write the release notes", "m1");
    await until(() => c.events.some(e => e.type === "status_change" && e.to === "idle" && e.seq > 2));

    const types = c.events.map(e => e.type);
    expect(types).toEqual(["status_change", "user_message", "status_change", "tool_call", "tool_result", "agent_message", "file_diff", "status_change"]);
    expect(c.events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const diff = c.events.find(e => e.type === "file_diff");
    expect(diff).toMatchObject({ path: "notes.md", change: "added" });

    const log = execFileSync("git", ["log", "-1", "--format=%D|%s"], { cwd: dir }).toString().trim();
    expect(log).toContain(`HEAD -> ${branchForThread(runner.thread.id)}`);
    expect(log).toContain("Write the release notes");
  });

  it("lets a client resume from any seq without gaps or duplicates", async () => {
    const { runner, server } = await boot(fakeAdapter, "test-thread-2");
    runner.sendMessage("first");
    await runner.settled();
    const total = runner.store.latestSeq;

    const c = connect(server.port, token(runner.thread.id), 3);
    await until(() => c.states.includes("live"));
    expect(c.events.map(e => e.seq)).toEqual(Array.from({ length: total - 3 }, (_, i) => i + 4));
  });

  it("rejects tokens for another thread or signed with another secret", async () => {
    const { runner, server } = await boot(fakeAdapter, "test-thread-3");
    const wrongThread = connect(server.port, token("someone-else"));
    const wrongSecret = connect(server.port, token(runner.thread.id, "a-different-secret-entirely"));
    const runnerScope = connect(server.port, token(runner.thread.id, SECRET, "runner"));
    await until(() => wrongThread.errors.length > 0 && wrongSecret.errors.length > 0 && runnerScope.errors.length > 0);
    expect(wrongThread.events).toEqual([]);
    expect(wrongSecret.errors[0]).toMatch(/signature/);
    expect(runnerScope.events).toEqual([]);
  });

  it("queues messages sent while busy and runs them in order after the turn", async () => {
    const prompts: string[] = [];
    const releases: (() => void)[] = [];
    const slow: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: ctx =>
          new Promise<void>(resolve => {
            prompts.push(ctx.prompt);
            releases.push(resolve);
            ctx.signal.addEventListener("abort", () => resolve());
          }),
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const { runner } = await boot(slow, "test-thread-4");
    expect(runner.sendMessage("long task", "a").result).toBe("started");
    expect(runner.sendMessage("second", "b").result).toBe("queued");
    expect(runner.sendMessage("third", "c").result).toBe("queued");
    expect(runner.queued.map(q => q.clientMsgId)).toEqual(["b", "c"]);
    const lastQueue = () => runner.store.since(0).filter(e => e.type === "queue_update").at(-1) as { queue: { clientMsgId: string }[] };
    expect(lastQueue().queue.map(q => q.clientMsgId)).toEqual(["b", "c"]);

    // Interrupting stops only the current turn; the queue carries on.
    runner.interrupt();
    await until(() => prompts.length === 2);
    expect(prompts).toEqual(["long task", "second"]);
    expect(lastQueue().queue.map(q => q.clientMsgId)).toEqual(["c"]);
    releases[1]!();
    await until(() => prompts.length === 3);
    releases[2]!();
    await runner.settled();

    const users = runner.store.since(0).filter(e => e.type === "user_message").map(e => (e as { clientMsgId?: string }).clientMsgId);
    expect(users).toEqual(["a", "b", "c"]);
    expect(lastQueue().queue).toEqual([]);
    expect(runner.store.since(0).filter(e => e.type === "status_change" && e.to === "idle" && e.reason === "interrupted")).toHaveLength(1);
  });

  it("never starts a turn twice for the same request id", async () => {
    const { runner, server } = await boot(fakeAdapter, "test-thread-7");
    expect(runner.sendMessage("once", "same-id").result).toBe("started");
    expect(runner.sendMessage("once", "same-id").result).toBe("duplicate");
    await runner.settled();

    // Over the wire too: a retry is acknowledged as a duplicate and nothing runs.
    const c = connect(server.port, token(runner.thread.id));
    await until(() => c.states.includes("live"));
    c.client.send("once", "same-id");
    c.client.send("new one", "other-id");
    await until(() => c.acks.length === 2);
    expect(c.acks).toEqual(["same-id:duplicate", "other-id:started"]);
    await runner.settled();
    expect(runner.store.since(0).filter(e => e.type === "user_message")).toHaveLength(2);
  });

  it("after a crash mid-turn, keeps the changes, says so, never re-runs it, then runs the queue", async () => {
    const dir = tempRepo();
    const dataDir = join(dir, ".lemonlime");
    const thread = makeThread("crash-thread-1");
    // Pretend a previous runner died while working on "interrupted work", with one message queued.
    const first = new ThreadRunner({ thread, workdir: dir, dataDir, adapter: fakeAdapter, session: { autonomy: "edits" } });
    await first.init();
    first.store.append({ type: "user_message", text: "interrupted work", clientMsgId: "lost" });
    await first.close();
    writeFileSync(join(dataDir, "state.json"), JSON.stringify({ agentState: {}, status: "running", queue: [{ clientMsgId: "next", text: "queued work", queuedAt: new Date().toISOString() }] }));
    writeFileSync(join(dir, "half-done.txt"), "partial\n");

    const prompts: string[] = [];
    const recording: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({ runTurn: async ctx => void prompts.push(ctx.prompt), saveState: () => ({}), dispose: async () => {} }),
    };
    const second = new ThreadRunner({ thread, workdir: dir, dataDir, adapter: recording, session: { autonomy: "edits" } });
    cleanups.push(() => second.close());
    await second.init();
    await second.settled();

    expect(prompts).toEqual(["queued work"]);
    const events = second.store.since(0);
    expect(events.find(e => e.type === "error" && e.code === "turn_outcome_unknown")).toBeDefined();
    expect(events.find(e => e.type === "file_diff" && e.path === "half-done.txt")).toBeDefined();
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: dir }).toString();
    expect(log).toContain("Unfinished changes from a turn the runner did not finish");
    // The interrupted message is never sent again, even if a client retries it.
    expect(second.sendMessage("interrupted work", "lost").result).toBe("duplicate");
  });

  it("drives an ACP agent over stdio, including permission requests", async () => {
    const adapter = acpAdapter("acp", ["node", join(here, "fixtures", "fake-acp-agent.mjs")]);
    const { runner } = await boot(adapter, "test-thread-5");
    runner.sendMessage("hello there");
    await runner.settled();
    const events = runner.store.since(0);
    const text = events.filter(e => e.type === "agent_message").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("You said: hello there");
    expect(events.find(e => e.type === "tool_call")).toMatchObject({ name: "Run tests", input: { command: "npm test" } });
    // Edits autonomy: "execute" tools are declined.
    expect(events.find(e => e.type === "tool_result")).toMatchObject({ output: "permission=deny", isError: false });
  });

  it("reports a missing agent CLI as an error instead of crashing", async () => {
    const adapter = acpAdapter("acp", ["definitely-not-a-real-agent-binary"]);
    const { runner } = await boot(adapter, "test-thread-6");
    runner.sendMessage("hi");
    await runner.settled();
    const err = runner.store.since(0).find(e => e.type === "error");
    expect(err).toMatchObject({ code: "agent_not_found", fatal: false });
    expect(runner.thread.status).toBe("idle");
  });
});

describe("local threads in their own worktree", () => {
  it("runs the agent in a worktree and leaves the user's checkout alone", async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "README.md"), "# my unsaved edit\n");
    const home = mkdtempSync(join(tmpdir(), "lemonlime-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const workdir = join(home, "worktrees", "demo", "wt-thread-1");
    const runner = new ThreadRunner({
      thread: makeThread("wt-thread-1"),
      workdir,
      dataDir: join(home, "threads", "wt-thread-1"),
      adapter: fakeAdapter,
      session: { autonomy: "edits" },
      sourceRepo: repo,
    });
    cleanups.push(() => runner.close());
    await runner.init();
    runner.sendMessage("hello");
    await runner.settled();

    const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir }).toString().trim();
    expect(readFileSync(join(workdir, "notes.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(repo, "notes.md"))).toBe(false);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# my unsaved edit\n");
    expect(git(repo, "show", "agent/wt-thread-1:notes.md")).toBe("hello");
    expect(runner.store.since(0).some(e => e.type === "file_diff" && e.path === "notes.md")).toBe(true);
    expect(existsSync(join(home, "threads", "wt-thread-1", "events.jsonl"))).toBe(true);
  });
});

