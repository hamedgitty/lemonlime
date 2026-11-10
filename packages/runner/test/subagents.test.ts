import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread, deriveAgentKey } from "@lemonlime/protocol";
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

/** `live`: the agent's sessions can change mode between turns, instead of being started again. */
async function boot({ live = false } = {}) {
  const mainPrompts: string[] = [];
  const childPrompts: string[] = [];
  /** What each subagent turn was allowed to do. */
  const childModes: string[] = [];
  let release: () => void = () => {};
  const adapter: AgentAdapter = {
    kind: "claude-code",
    createSession: opts => {
      let mode = opts.autonomy;
      return {
        runTurn: async ctx => {
          if (!opts.env?.LEMONLIME_SUBAGENT_ID) return void mainPrompts.push(ctx.prompt);
          childPrompts.push(ctx.prompt);
          childModes.push(mode);
          if (ctx.prompt.includes("slow")) {
            await new Promise<void>(r => {
              release = r;
              ctx.signal.addEventListener("abort", () => r(), { once: true });
            });
          }
          if (ctx.prompt.includes("risky")) {
            const answer = (await ctx.requestApproval?.({ tool: "Bash", input: { command: "make clean" }, summary: "make clean" })) ?? "nobody to ask";
            return ctx.emit({ type: "agent_message", text: `child was told: ${answer}` });
          }
          ctx.emit({ type: "agent_message", text: `child done: ${ctx.prompt.split("\n").at(-1)}` });
        },
        saveState: () => ({ conversation: "kept" }),
        ...(live ? { setOptions: (change: { autonomy?: typeof mode }) => void (mode = change.autonomy ?? mode) } : {}),
        dispose: async () => {},
      };
    },
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
    mine: true,
    shared: false,
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
  const env = { LEMONLIME_RUNNER_URL: `http://127.0.0.1:${server.port}`, LEMONLIME_THREAD_ID: thread.id, LEMONLIME_AGENT_KEY: await deriveAgentKey(SECRET) };
  return { runner, env, mainPrompts, childPrompts, childModes, release: () => release() };
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
    // The apps follow each subagent's state from snapshots in the history.
    const states = runner.store.since(0).flatMap(e => (e.type === "subagent_update" ? [e.subagents.map(s => s.status).join(",")] : []));
    expect(states).toEqual(["working", "idle", "working", "idle"]);
  });

  it("count a subagent whose own subagents are still working as waiting", async () => {
    const { runner, env, release } = await boot();
    const parent = /sub-\w+/.exec(textOf(await runSubagentTool("spawn_subagent", { request_id: "p", task: "lead" }, env)))![0];
    await until(() => runner.subagents.list().every(a => a.status === "idle"));
    await runSubagentTool("spawn_subagent", { request_id: "c", task: "slow part" }, { ...env, LEMONLIME_SUBAGENT_ID: parent });
    expect(runner.subagents.snapshot().map(s => [s.parentId === null ? "parent" : "child", s.status])).toEqual([
      ["parent", "waiting"],
      ["child", "working"],
    ]);
    release();
    // The reply wakes the parent, whose prompt mentions the slow part too.
    await until(() => runner.subagents.snapshot()[1]!.status === "idle");
    release();
    await until(() => runner.subagents.snapshot().every(s => s.status === "idle"));
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
    expect(await runSubagentTool("spawn_subagent", { request_id: "x", task: "y" }, { ...env, LEMONLIME_AGENT_KEY: "wrong-secret-0123456789" })).toMatchObject({
      isError: true,
    });
    release();
  });

  for (const live of [false, true]) {
    it(`may do what the thread's agent may do now, not what it could when the thread started${live ? " (mode changed in place)" : ""}`, async () => {
      const { runner, env, mainPrompts, childModes } = await boot({ live });
      expect(runner.setOptions({ permission: "ask" })).toEqual({ ok: true });
      const id = /sub-\w+/.exec(textOf(await runSubagentTool("spawn_subagent", { request_id: "m1", task: "tidy up" }, env)))![0];
      await until(() => mainPrompts.length === 1);
      await runner.settled();

      // A later change reaches a subagent that already exists, from its next turn.
      expect(runner.setOptions({ permission: "edits" })).toEqual({ ok: true });
      await runSubagentTool("message_subagent", { id, text: "and the tests" }, env);
      await until(() => mainPrompts.length === 2);
      await runner.settled();

      // While the thread's agent is planning, a subagent only looks.
      expect(runner.setOptions({ permission: "plan" })).toEqual({ ok: true });
      await runSubagentTool("message_subagent", { id, text: "what would you change?" }, env);
      await until(() => childModes.length === 3);
      expect(childModes).toEqual(["ask", "edits", "read"]);
    });
  }

  it("ask the user before doing something the thread's mode says to ask about", async () => {
    const { runner, env, mainPrompts } = await boot();
    runner.setOptions({ permission: "ask" });
    await runSubagentTool("spawn_subagent", { request_id: "a1", task: "risky cleanup" }, env);
    const asked = () => runner.store.since(0).flatMap(e => (e.type === "approval_request" ? [e] : []));
    await until(() => asked().length === 1);
    expect(asked()[0]).toMatchObject({ tool: "Bash", summary: "make clean" });
    expect(mainPrompts).toHaveLength(0);
    expect(runner.answerApproval(asked()[0]!.requestId, "allow")).toBe(true);
    await until(() => mainPrompts.length === 1);
    expect(mainPrompts[0]).toContain("child was told: allow");
  });

  it("stop when the user stops the agent, without waking it with half a reply", async () => {
    const { runner, env, mainPrompts, childPrompts } = await boot();
    runner.setOptions({ permission: "ask" });
    const slow = /sub-\w+/.exec(textOf(await runSubagentTool("spawn_subagent", { request_id: "s1", task: "slow job" }, env)))![0];
    await runSubagentTool("spawn_subagent", { request_id: "s2", task: "risky job" }, env);
    await runSubagentTool("message_subagent", { id: slow, text: "one more thing" }, env);
    await until(() => runner.store.since(0).some(e => e.type === "approval_request"));

    runner.interrupt();
    await until(() => runner.subagents.list().every(a => a.status === "idle"));
    expect(runner.subagents.list().map(a => a.lastReply)).toEqual(["Stopped before it finished.", "Stopped before it finished."]);
    // The question it was waiting on is closed, and the follow-up that was waiting is dropped.
    expect(runner.store.since(0).flatMap(e => (e.type === "approval_result" ? [[e.decision, e.by]] : []))).toEqual([["deny", "interrupted"]]);
    await new Promise(r => setTimeout(r, 50));
    expect(childPrompts).toHaveLength(2);
    expect(mainPrompts).toHaveLength(0);

    // It can be given more work afterwards.
    await runSubagentTool("message_subagent", { id: slow, text: "carry on" }, env);
    await until(() => mainPrompts.length === 1);
    expect(mainPrompts[0]).toContain("child done: carry on");
  });
});
