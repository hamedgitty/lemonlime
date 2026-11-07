import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { ApprovalBridge, startServer, ThreadRunner, type AgentAdapter, type ApprovalDecision } from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function thread(id: string): Thread {
  const now = new Date().toISOString();
  return { id, title: "", agent: { kind: "claude-code" }, repo: { url: "local", baseBranch: "main" }, branch: branchForThread(id), mode: "local", status: "provisioning", sandboxSize: "small", latestSeq: 0, createdAt: now, updatedAt: now };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-appr-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

/** An agent that asks once per turn to run `npm test` and reports the answer. */
const asking: AgentAdapter = {
  kind: "claude-code",
  createSession: () => ({
    async runTurn(ctx) {
      const d = ctx.requestApproval ? await ctx.requestApproval({ tool: "Bash", input: { command: "npm test" }, summary: "npm test" }) : "deny";
      ctx.emit({ type: "agent_message", text: `answer=${d}` });
    },
    saveState: () => ({}),
    dispose: async () => {},
  }),
};

async function boot(id: string, extra: Partial<ConstructorParameters<typeof ThreadRunner>[0]> = {}, dir = repo()) {
  const runner = new ThreadRunner({ thread: thread(id), workdir: dir, dataDir: join(dir, ".lemonlime"), adapter: asking, session: { autonomy: "edits" }, ...extra });
  await runner.init();
  cleanups.push(() => runner.close());
  return runner;
}

const lastAnswer = (r: ThreadRunner) => (r.store.since(0).filter(e => e.type === "agent_message").at(-1) as { text: string } | undefined)?.text;
const results = (r: ThreadRunner) => r.store.since(0).filter(e => e.type === "approval_result");
const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("timed out");
    await new Promise(res => setTimeout(res, 10));
  }
};

describe("approvals in the runner", () => {
  it("waits for the user's answer and ignores a second one", async () => {
    const runner = await boot("appr-thread-1");
    runner.sendMessage("go");
    await until(() => runner.store.since(0).some(e => e.type === "approval_request"));
    const req = runner.store.since(0).find(e => e.type === "approval_request") as { requestId: string; summary: string };
    expect(req.summary).toBe("npm test");
    expect(runner.answerApproval(req.requestId, "allow")).toBe(true);
    expect(runner.answerApproval(req.requestId, "deny")).toBe(false);
    await runner.settled();
    expect(lastAnswer(runner)).toBe("answer=allow");
    expect(results(runner)).toMatchObject([{ decision: "allow", by: "user" }]);
  });

  it("declines when nobody answers in time, and when the user stops the turn", async () => {
    const runner = await boot("appr-thread-2", { approvalTimeoutMs: 50 });
    runner.sendMessage("first");
    await runner.settled();
    expect(lastAnswer(runner)).toBe("answer=deny");
    expect(results(runner).at(-1)).toMatchObject({ decision: "deny", by: "timeout" });

    const patient = await boot("appr-thread-3");
    patient.sendMessage("second");
    await until(() => patient.store.since(0).some(e => e.type === "approval_request"));
    patient.interrupt();
    await patient.settled();
    expect(results(patient).at(-1)).toMatchObject({ decision: "deny", by: "interrupted" });
  });

  it("marks questions from a stopped runner as expired", async () => {
    const dir = repo();
    const first = await boot("appr-thread-4", {}, dir);
    first.sendMessage("go");
    await until(() => first.store.since(0).some(e => e.type === "approval_request"));
    // Simulate the process dying: history keeps the open question.
    const second = new ThreadRunner({ thread: thread("appr-thread-4"), workdir: dir, dataDir: join(dir, ".lemonlime"), adapter: asking, session: { autonomy: "edits" } });
    await second.init();
    cleanups.push(() => second.close());
    expect(results(second).at(-1)).toMatchObject({ decision: "deny", by: "expired" });
  });

  it("takes the answer over the WebSocket", async () => {
    const runner = await boot("appr-thread-5");
    const secret = "approval-secret-for-tests-0123456789";
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: secret, version: "test" });
    cleanups.push(() => server.close());
    const client = new RunnerClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: () => signToken({ threadId: "appr-thread-5", scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, secret),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onEvent: e => {
        if (e.type === "approval_request") client.approve(e.requestId, "allow");
      },
    });
    client.connect();
    cleanups.push(() => client.close());
    client.send("go", "m1");
    await until(() => lastAnswer(runner) === "answer=allow");
  });
});

describe("approval bridge and helper", () => {
  it("only answers callers with the token", async () => {
    const bridge = await ApprovalBridge.start(async () => "allow");
    cleanups.push(() => bridge.close());
    const post = (auth: string) =>
      fetch(bridge.url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ tool: "Bash", input: {} }) });
    expect((await post("Bearer wrong")).status).toBe(404);
    expect(await (await post(`Bearer ${bridge.token}`)).json()).toEqual({ decision: "allow" });
  });

  it("the MCP helper Claude Code runs forwards questions and returns the answer", async () => {
    const asked: string[] = [];
    let answer: ApprovalDecision = "allow";
    const bridge = await ApprovalBridge.start(async req => {
      asked.push(req.summary);
      return answer;
    });
    cleanups.push(() => bridge.close());
    const child = spawn(process.execPath, [join(here, "..", "bin", "approval-mcp.mjs")], {
      env: { ...process.env, LEMONLIME_APPROVAL_URL: bridge.url, LEMONLIME_APPROVAL_TOKEN: bridge.token },
      stdio: ["pipe", "pipe", "inherit"],
    });
    cleanups.push(() => void child.kill());
    const replies = new Map<number, unknown>();
    createInterface({ input: child.stdout! }).on("line", l => {
      const m = JSON.parse(l) as { id: number };
      replies.set(m.id, m);
    });
    const call = async (id: number, method: string, params: unknown) => {
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      await until(() => replies.has(id));
      return replies.get(id) as { result?: { content?: { text: string }[]; tools?: { name: string }[] }; error?: unknown };
    };
    expect((await call(1, "initialize", { protocolVersion: "2025-11-25" })).result).toBeDefined();
    expect((await call(2, "tools/list", {})).result?.tools?.map(t => t.name)).toEqual(["approve"]);
    const allow = await call(3, "tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "npm test" }, tool_use_id: "t1" } });
    expect(JSON.parse(allow.result!.content![0]!.text)).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    answer = "deny";
    const deny = await call(4, "tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "rm -rf build" } } });
    expect(JSON.parse(deny.result!.content![0]!.text)).toMatchObject({ behavior: "deny" });
    expect(asked).toEqual(["npm test", "rm -rf build"]);
    expect((await call(5, "server/discover", {})).error).toBeDefined();
  });
});
