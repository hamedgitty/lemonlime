import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { runSubagentTool, startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

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

async function boot() {
  const mainPrompts: string[] = [];
  const childPrompts: string[] = [];
  let release: () => void = () => {};
  const adapter: AgentAdapter = {
    kind: "claude-code",
    createSession: opts => ({
      runTurn: async ctx => {
        if (opts.env?.LEMONLIME_SUBAGENT_ID) {
          childPrompts.push(ctx.prompt);
          if (ctx.prompt.includes("slow")) await new Promise<void>(r => (release = r));
          ctx.emit({ type: "agent_message", text: `child done: ${ctx.prompt.split("\n").at(-1)}` });
        } else mainPrompts.push(ctx.prompt);
      },
      saveState: () => ({}),
      dispose: async () => {},
    }),
  };
  const now = new Date().toISOString();
  const thread: Thread = {
    id: "sub-thread-1",
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread("sub-thread-1"),
    mode: "cloud",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  const env = { LEMONLIME_RUNNER_URL: `http://127.0.0.1:${server.port}`, LEMONLIME_THREAD_ID: thread.id, LEMONLIME_THREAD_SECRET: SECRET };
  return { runner, env, mainPrompts, childPrompts, release: () => release() };
}
const textOf = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("subagents", () => {
  it("start once per request, work on their own, and report back to the agent that asked", async () => {
    const { runner, env, mainPrompts, childPrompts } = await boot();
    const first = await runSubagentTool("spawn_subagent", { request_id: "r1", task: "Write tests for the parser" }, env);
    const again = await runSubagentTool("spawn_subagent", { request_id: "r1", task: "Write tests for the parser" }, env);
    expect(textOf(first)).toMatch(/Started subagent sub-/);
    expect(textOf(again)).toBe(textOf(first)); // same id, not a second one
    await until(() => mainPrompts.length === 1);
    expect(childPrompts).toHaveLength(1);
    expect(childPrompts[0]).toContain("You are a subagent");
    expect(mainPrompts[0]).toMatch(/^Subagent sub-\w+ \(task: Write tests for the parser\) replied:\n\nchild done: Task: Write tests for the parser/);
    await runner.settled();
    const list = JSON.parse(textOf(await runSubagentTool("list_subagents", {}, env))) as { id: string; status: string }[];
    expect(list).toMatchObject([{ status: "idle" }]);

    // A follow-up gets its own reply, delivered the same way.
    await runSubagentTool("message_subagent", { id: list[0]!.id, text: "and the lexer" }, env);
    await until(() => mainPrompts.length === 2);
    expect(mainPrompts[1]).toContain("child done: and the lexer");
    const codes = runner.store
      .since(0)
      .filter(e => e.type === "notice")
      .map(e => (e as { code: string }).code);
    expect(codes).toEqual(expect.arrayContaining(["subagent_started", "subagent_replied"]));
  });

  it("go two levels deep at most, three at a time, and only the starter can message one", async () => {
    const { env, release } = await boot();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const r = await runSubagentTool("spawn_subagent", { request_id: `slow-${n}`, task: `slow job ${n}` }, env);
      ids.push(/sub-\w+/.exec(textOf(r))![0]);
    }
    const fourth = await runSubagentTool("spawn_subagent", { request_id: "slow-4", task: "slow job 4" }, env);
    expect(fourth).toMatchObject({ isError: true });
    const childEnv = { ...env, LEMONLIME_SUBAGENT_ID: ids[0]! };
    const grandchild = await runSubagentTool("spawn_subagent", { request_id: "g1", task: "quick part" }, childEnv);
    const grandId = /sub-\w+/.exec(textOf(grandchild))![0];
    const tooDeep = await runSubagentTool("spawn_subagent", { request_id: "gg1", task: "deeper" }, { ...env, LEMONLIME_SUBAGENT_ID: grandId });
    expect(textOf(tooDeep)).toMatch(/2 levels deep/);
    expect(await runSubagentTool("message_subagent", { id: ids[1]!, text: "hi" }, childEnv)).toMatchObject({ isError: true });
    expect(
      await runSubagentTool("spawn_subagent", { request_id: "x", task: "y" }, { ...env, LEMONLIME_THREAD_SECRET: "wrong-secret-0123456789" }),
    ).toMatchObject({ isError: true });
    release();
  });
});
