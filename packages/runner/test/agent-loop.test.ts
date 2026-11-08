// The agent loop around a turn: changing options between turns, plan mode, the agent's
// to-do list, its questions, and how full its context window is.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { agentLoopState, branchForThread, signToken, type AgentKind, type NewEvent, type Thread, type ThreadOptions } from "@lemonlime/protocol";
import {
  acpAdapter,
  AcpTranslator,
  adapterFor,
  agentModes,
  answerAgentRequest,
  codexContextUsage,
  CodexTodos,
  findRollout,
  needsApproval,
  newClaudeParseState,
  parseClaudeLine,
  parseCodexLine,
  PlanHold,
  startServer,
  ThreadRunner,
  type AgentAdapter,
  type SessionOptions,
} from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-loop-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("timed out");
    await new Promise(res => setTimeout(res, 10));
  }
};

function thread(id: string, kind: AgentKind = "claude-code"): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind },
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

async function boot(id: string, adapter: AgentAdapter, extra: Partial<ConstructorParameters<typeof ThreadRunner>[0]> = {}) {
  const runner = new ThreadRunner({
    thread: thread(id, adapter.kind),
    workdir: temp(),
    dataDir: null,
    adapter,
    session: { autonomy: "edits" },
    git: false,
    bundledSkills: false,
    ...extra,
  });
  await runner.init();
  cleanups.push(() => runner.close());
  return runner;
}

const line = (o: unknown) => JSON.stringify(o);
const ofType = <T extends NewEvent["type"]>(events: readonly { type: string }[], type: T) =>
  events.filter(e => e.type === type) as Extract<NewEvent, { type: T }>[];

describe("Claude Code's to-dos, plans, questions and usage", () => {
  it("turns TodoWrite into a to-do snapshot and leaves its result out", () => {
    const state = newClaudeParseState();
    const call = parseClaudeLine(
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Read the code", status: "completed", activeForm: "Reading" },
                  { content: "Fix the bug", status: "in_progress", activeForm: "Fixing" },
                  { content: "Run tests", status: "pending", activeForm: "Running" },
                ],
              },
            },
          ],
        },
      }),
      state,
    );
    expect(call.events).toEqual([
      {
        type: "todo_snapshot",
        items: [
          { text: "Read the code", status: "completed" },
          { text: "Fix the bug", status: "in_progress" },
          { text: "Run tests", status: "pending" },
        ],
      },
    ]);
    const result = parseClaudeLine(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Todos updated" }] } }), state);
    expect(result.events).toEqual([]);
  });

  it("keeps a list from the task tools, by the ids their results give", () => {
    const state = newClaudeParseState();
    const tool = (id: string, name: string, input: unknown) =>
      parseClaudeLine(line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }), state).events;
    const result = (id: string, content: string) =>
      parseClaudeLine(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } }), state).events;
    expect(tool("c1", "TaskCreate", { subject: "Write tests", description: "..." })).toEqual([]);
    expect(result("c1", "Task #1 created successfully: Write tests")).toEqual([{ type: "todo_snapshot", items: [{ text: "Write tests", status: "pending" }] }]);
    tool("c2", "TaskCreate", { subject: "Ship it" });
    result("c2", "Task #2 created successfully: Ship it");
    expect(tool("u1", "TaskUpdate", { taskId: "1", status: "in_progress" })).toEqual([
      {
        type: "todo_snapshot",
        items: [
          { text: "Write tests", status: "in_progress" },
          { text: "Ship it", status: "pending" },
        ],
      },
    ]);
    expect(result("u1", "Updated task #1 status")).toEqual([]);
  });

  it("shows ExitPlanMode as a plan and hides AskUserQuestion's tool rows", () => {
    const state = newClaudeParseState();
    const plan = parseClaudeLine(
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "\n# Plan\n1. Do it\n" } }] } }),
      state,
    );
    expect(plan.events).toEqual([{ type: "plan_proposal", plan: "# Plan\n1. Do it" }]);
    const denied = parseClaudeLine(
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "shown", is_error: true }] } }),
      state,
    );
    expect(denied.events).toEqual([]);
    const ask = parseClaudeLine(
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [] } }] } }),
      state,
    );
    expect(ask.events).toEqual([]);
  });

  it("reports the context used by the latest top-level reply, of the model's window", () => {
    const state = newClaudeParseState();
    const usage = { input_tokens: 2, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 23_000, output_tokens: 98 };
    parseClaudeLine(line({ type: "assistant", message: { model: "claude-x", content: [], usage } }), state);
    // A subagent's reply has its own context; it doesn't count.
    parseClaudeLine(
      line({ type: "assistant", parent_tool_use_id: "task1", message: { model: "claude-x", content: [], usage: { input_tokens: 999_999 } } }),
      state,
    );
    const result = parseClaudeLine(
      line({
        type: "result",
        subtype: "success",
        result: "ok",
        modelUsage: { "claude-small": { contextWindow: 100_000 }, "claude-x": { contextWindow: 1_000_000 } },
      }),
      state,
    );
    expect(result.events).toEqual([{ type: "context_usage", used: 43_100, window: 1_000_000 }]);
    // No window known (older CLIs, cleaned recordings): nothing is guessed.
    expect(parseClaudeLine(line({ type: "result", subtype: "success", result: "ok" }), state).events).toEqual([]);
  });
});

describe("Claude Code through the permission tool", () => {
  async function claude(id: string, autonomy: SessionOptions["autonomy"] = "edits") {
    const out = join(temp(), "args.json");
    const runner = await boot(id, adapterFor("claude-code"), {
      session: { autonomy, command: ["node", join(here, "fixtures", "fake-claude.mjs")], env: { ARGS_OUT: out }, subagents: false, commandGuard: false },
    });
    return { runner, args: () => (JSON.parse(readFileSync(out, "utf8")) as { args: string[] }).args };
  }

  it("asks the user its questions and gives the agent their answers, at every autonomy level", async () => {
    for (const autonomy of ["edits", "full"] as const) {
      const { runner, args } = await claude(`claude-ask-${autonomy}`, autonomy);
      runner.sendMessage("ask which database");
      await until(() => runner.store.since(0).some(e => e.type === "question_request"));
      const req = ofType(runner.store.since(0), "question_request")[0]!;
      expect(req.questions).toEqual([
        { question: "Which database?", header: "Database", options: [{ label: "SQLite" }, { label: "Postgres" }], multiSelect: false },
      ]);
      expect(runner.waitingApprovals).toBe(1);
      expect(runner.answerQuestion(req.requestId, [["Postgres"]])).toBe(true);
      expect(runner.answerQuestion(req.requestId, [["SQLite"]])).toBe(false);
      await runner.settled();
      const said = ofType(runner.store.since(0), "agent_message").map(e => e.text);
      expect(said.at(-1), autonomy).toBe("Going with Postgres.");
      expect(ofType(runner.store.since(0), "question_result")).toMatchObject([{ answers: [["Postgres"]], by: "user" }]);
      // The question itself isn't a tool row; the context meter has a reading.
      expect(ofType(runner.store.since(0), "tool_call")).toEqual([]);
      expect(ofType(runner.store.since(0), "context_usage").at(-1)).toMatchObject({ used: 2040, window: 200_000 });
      expect(args()).toContain("--permission-prompt-tool");
      expect(args()[args().indexOf("--permission-mode") + 1]).toBe(autonomy === "full" ? "bypassPermissions" : "acceptEdits");
    }
  });

  it("tells the agent when the question goes unanswered", async () => {
    const { runner } = await claude("claude-ask-decline");
    runner.sendMessage("ask again");
    await until(() => runner.store.since(0).some(e => e.type === "question_request"));
    const req = ofType(runner.store.since(0), "question_request")[0]!;
    runner.answerQuestion(req.requestId, null);
    await runner.settled();
    expect(ofType(runner.store.since(0), "agent_message").at(-1)?.text).toMatch(/^No answer: The user didn't answer/);
  });

  it("runs in Claude Code's plan mode, shows the plan and stops there", async () => {
    const { runner, args } = await claude("claude-plan");
    expect(runner.setOptions({ permission: "plan" })).toEqual({ ok: true });
    runner.sendMessage("plan the fix");
    await runner.settled();
    expect(args()[args().indexOf("--permission-mode") + 1]).toBe("plan");
    expect(ofType(runner.store.since(0), "plan_proposal")).toMatchObject([{ plan: "# Plan\n\n1. Read the code\n2. Fix the bug" }]);
    // The plan never became an approval for the user to answer.
    expect(ofType(runner.store.since(0), "approval_request")).toEqual([]);
    expect(runner.currentOptions).toMatchObject({ permission: "plan", exitPlanTo: "edits" });
    // Approving: back to the earlier mode, from the next turn.
    runner.setOptions({ permission: "edits" });
    runner.sendMessage("go ahead");
    await runner.settled();
    expect(args()[args().indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(runner.currentOptions.exitPlanTo).toBeUndefined();
  });
});

describe("changing options mid-thread", () => {
  /** An agent that records the options of every turn, and whether it was told about changes. */
  function recording(withSetOptions: boolean) {
    const turns: { model?: string; reasoning?: string; autonomy: string; saved: Record<string, string> }[] = [];
    let created = 0;
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession(opts) {
        created += 1;
        const o = { ...opts };
        let turnsHere = 0;
        return {
          async runTurn(ctx) {
            turnsHere += 1;
            turns.push({
              ...(o.model ? { model: o.model } : {}),
              ...(o.reasoning ? { reasoning: o.reasoning } : {}),
              autonomy: o.autonomy,
              saved: o.saved ?? {},
            });
            ctx.emit({ type: "agent_message", text: "ok" });
          },
          saveState: () => ({ sessionId: "s-1", turns: String(turnsHere) }),
          dispose: async () => {},
          ...(withSetOptions
            ? {
                setOptions(change) {
                  if (change.model !== undefined) o.model = change.model ?? undefined;
                  if (change.reasoning !== undefined) o.reasoning = change.reasoning ?? undefined;
                  if (change.autonomy) o.autonomy = change.autonomy;
                },
              }
            : {}),
        };
      },
    };
    return { adapter, turns, created: () => created };
  }

  it("applies from the next turn in the same session and records the change", async () => {
    const { adapter, turns, created } = recording(true);
    const runner = await boot("opts-live-1", adapter, { session: { autonomy: "edits", model: "sonnet" } });
    expect(runner.currentOptions).toEqual({ model: "sonnet", reasoning: null, permission: "edits" });
    runner.sendMessage("one");
    await runner.settled();
    expect(runner.setOptions({ model: "opus", reasoning: "high", permission: "ask" })).toEqual({ ok: true });
    runner.sendMessage("two");
    await runner.settled();
    expect(turns).toEqual([
      { model: "sonnet", autonomy: "edits", saved: {} },
      { model: "opus", reasoning: "high", autonomy: "ask", saved: {} },
    ]);
    expect(created()).toBe(1);
    expect(ofType(runner.store.since(0), "options_change")).toMatchObject([{ options: { model: "opus", reasoning: "high", permission: "ask" } }]);
    // Nothing changed: nothing recorded. Back to the default model: null.
    runner.setOptions({ model: "opus" });
    runner.setOptions({ model: null });
    expect(ofType(runner.store.since(0), "options_change").map(e => e.options.model)).toEqual(["opus", null]);
  });

  it("starts an agent that can't change in place again, in the same conversation", async () => {
    const { adapter, turns, created } = recording(false);
    const runner = await boot("opts-restart-1", adapter);
    runner.sendMessage("one");
    await runner.settled();
    runner.setOptions({ permission: "full" });
    runner.sendMessage("two");
    await runner.settled();
    expect(created()).toBe(2);
    expect(turns[1]).toEqual({ autonomy: "full", saved: { sessionId: "s-1", turns: "1" } });
  });

  it("refuses what the agent can't do", async () => {
    const codex = await boot("opts-refuse-1", { kind: "codex", createSession: () => recording(true).adapter.createSession({} as SessionOptions) });
    expect(codex.setOptions({ permission: "ask" })).toEqual({ error: "This agent can't run in Ask first mode." });
    const claude = await boot("opts-refuse-3", recording(true).adapter);
    expect(claude.setOptions({ reasoning: "max" })).toMatchObject({ error: expect.stringMatching(/max reasoning/) });
    const acp = await boot("opts-refuse-2", { kind: "acp", createSession: () => recording(true).adapter.createSession({} as SessionOptions) });
    expect(acp.setOptions({ model: "big" })).toMatchObject({ error: expect.stringMatching(/model can't be changed/) });
    expect(acp.setOptions({ permission: "plan" })).toEqual({ ok: true });
    expect(ofType(codex.store.since(0), "options_change")).toEqual([]);
  });

  it("keeps changed options when the runner starts again", async () => {
    const dataDir = temp();
    const workdir = temp();
    const first = new ThreadRunner({
      thread: thread("opts-keep-1"),
      workdir,
      dataDir,
      adapter: recording(true).adapter,
      session: { autonomy: "edits" },
      git: false,
      bundledSkills: false,
    });
    await first.init();
    first.setOptions({ permission: "plan", model: "haiku" });
    await first.close();
    const again = recording(true);
    const second = new ThreadRunner({
      thread: thread("opts-keep-1"),
      workdir,
      dataDir,
      adapter: again.adapter,
      session: { autonomy: "edits" },
      git: false,
      bundledSkills: false,
    });
    await second.init();
    cleanups.push(() => second.close());
    expect(second.currentOptions).toEqual<ThreadOptions>({ model: "haiku", reasoning: null, permission: "plan", exitPlanTo: "edits" });
    second.sendMessage("hi");
    await second.settled();
    expect(again.turns[0]).toMatchObject({ model: "haiku", autonomy: "plan" });
  });

  it("works over the WebSocket: the welcome has the options, a refusal comes back as an error", async () => {
    const { adapter } = recording(true);
    const runner = await boot("opts-ws-1", { ...adapter, kind: "codex" });
    const secret = "options-secret-for-tests-0123456789";
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: secret, version: "test" });
    cleanups.push(() => server.close());
    let welcomed: ThreadOptions | undefined;
    const errors: string[] = [];
    const client = new RunnerClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      token: () => signToken({ threadId: "opts-ws-1", scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, secret),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      onWelcome: (_t, _s, options) => (welcomed = options),
      onError: m => errors.push(m),
    });
    client.connect();
    cleanups.push(() => client.close());
    await until(() => welcomed !== undefined);
    expect(welcomed).toEqual({ model: null, reasoning: null, permission: "edits" });
    client.setOptions({ permission: "ask" });
    client.setOptions({ permission: "plan", reasoning: "high" });
    await until(() => errors.length > 0 && runner.currentOptions.permission === "plan");
    expect(errors[0]).toMatch(/Ask first/);
    const caps = (await (await fetch(`http://127.0.0.1:${server.port}/capabilities`)).json()) as {
      permission: string;
      reasoningLevel: string;
      permissions: string[];
    };
    expect(caps).toMatchObject({ permission: "plan", reasoningLevel: "high", permissions: ["edits", "full", "plan"] });
  });
});

describe("questions in the runner", () => {
  const asking: AgentAdapter = {
    kind: "claude-code",
    createSession: () => ({
      async runTurn(ctx) {
        const answers = ctx.askQuestions
          ? await ctx.askQuestions([
              { question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: true },
              { question: "Name?", options: [], multiSelect: false },
            ])
          : null;
        ctx.emit({ type: "agent_message", text: `answers=${JSON.stringify(answers)}` });
      },
      saveState: () => ({}),
      dispose: async () => {},
    }),
  };

  it("waits like an approval, and keeps one answer list per question", async () => {
    const runner = await boot("q-wait-1", asking);
    runner.sendMessage("go");
    await until(() => runner.store.since(0).some(e => e.type === "question_request"));
    const req = ofType(runner.store.since(0), "question_request")[0]!;
    expect(agentLoopState(runner.store.since(0)).question?.requestId).toBe(req.requestId);
    runner.answerQuestion(req.requestId, [["A", "B", " "], [" my-app "], ["extra"]]);
    await runner.settled();
    expect(ofType(runner.store.since(0), "agent_message").at(-1)?.text).toBe('answers=[["A","B"],["my-app"]]');
    expect(agentLoopState(runner.store.since(0)).question).toBeNull();
  });

  it("gives up after the approval timeout, when the turn stops, and after a restart", async () => {
    const quick = await boot("q-timeout-1", asking, { approvalTimeoutMs: 50 });
    quick.sendMessage("go");
    await quick.settled();
    expect(ofType(quick.store.since(0), "question_result")).toMatchObject([{ answers: null, by: "timeout" }]);

    const stopped = await boot("q-stop-1", asking);
    stopped.sendMessage("go");
    await until(() => stopped.store.since(0).some(e => e.type === "question_request"));
    stopped.interrupt();
    await stopped.settled();
    expect(ofType(stopped.store.since(0), "question_result")).toMatchObject([{ answers: null, by: "interrupted" }]);

    const dataDir = temp();
    const workdir = temp();
    const first = new ThreadRunner({
      thread: thread("q-expire-1"),
      workdir,
      dataDir,
      adapter: asking,
      session: { autonomy: "edits" },
      git: false,
      bundledSkills: false,
    });
    await first.init();
    first.sendMessage("go");
    await until(() => first.store.since(0).some(e => e.type === "question_request"));
    const second = new ThreadRunner({
      thread: thread("q-expire-1"),
      workdir,
      dataDir,
      adapter: asking,
      session: { autonomy: "edits" },
      git: false,
      bundledSkills: false,
    });
    await second.init();
    cleanups.push(() => second.close());
    cleanups.push(() => first.close());
    expect(ofType(second.store.since(0), "question_result").at(-1)).toMatchObject({ answers: null, by: "expired" });
  });
});

describe("Codex's plan, to-dos and usage", () => {
  it("turns todo_list items into snapshots, once per change", () => {
    const todos = new CodexTodos();
    const item = (items: { text: string; completed: boolean }[]) => ({ id: "item_1", type: "todo_list", items });
    const started = parseCodexLine(
      line({
        type: "item.started",
        item: item([
          { text: "Look", completed: false },
          { text: "Fix", completed: false },
        ]),
      }),
      todos,
    );
    expect(started.events).toEqual([
      {
        type: "todo_snapshot",
        items: [
          { text: "Look", status: "in_progress" },
          { text: "Fix", status: "pending" },
        ],
      },
    ]);
    const updated = parseCodexLine(
      line({
        type: "item.updated",
        item: item([
          { text: "Look", completed: true },
          { text: "Fix", completed: false },
        ]),
      }),
      todos,
    );
    expect(updated.events[0]).toMatchObject({ items: [{ status: "completed" }, { status: "in_progress" }] });
    expect(
      parseCodexLine(
        line({
          type: "item.completed",
          item: item([
            { text: "Look", completed: true },
            { text: "Fix", completed: false },
          ]),
        }),
        todos,
      ).events,
    ).toEqual([]);
    // Other items' updates are still not shown.
    expect(parseCodexLine(line({ type: "item.updated", item: { id: "c", type: "command_execution", command: "ls" } }), todos).events).toEqual([]);
  });

  it("reads the context meter from the newest token count in Codex's session log", () => {
    const home = temp();
    const day = join(home, "sessions", "2026", "11", "08");
    mkdirSync(day, { recursive: true });
    const id = "01a1b9f9-868c-72b1-b46a-cd28adec5b9f";
    const file = join(day, `rollout-2026-11-08T02-05-00-${id}.jsonl`);
    const count = (total: number) =>
      line({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 258_400 } } });
    writeFileSync(
      file,
      [
        line({ type: "session_meta", payload: { id } }),
        count(20_000),
        line({ type: "event_msg", payload: { type: "token_count", info: null } }),
        count(25_358),
      ].join("\n") + "\n",
    );
    expect(findRollout(home, id)).toBe(file);
    expect(findRollout(home, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(codexContextUsage(file)).toEqual({ used: 25_358, window: 258_400 });
  });

  it("runs read-only in plan mode, says what plan mode means, and shows its last message as the plan", async () => {
    const out = join(temp(), "codex.cjs");
    const argsFile = join(temp(), "args.json");
    // A stand-in `codex exec --json`: says something, runs a command, then replies with a plan.
    writeFileSync(
      out,
      `const fs=require("fs");fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));const p=s=>console.log(JSON.stringify(s));
p({type:"thread.started",thread_id:"th-plan"});
p({type:"item.completed",item:{id:"i0",type:"agent_message",text:"Looking around."}});
p({type:"item.started",item:{id:"i1",type:"command_execution",command:"ls"}});
p({type:"item.completed",item:{id:"i1",type:"command_execution",command:"ls",aggregated_output:"a.js",exit_code:0,status:"completed"}});
p({type:"item.completed",item:{id:"i2",type:"agent_message",text:"## Plan\\n1. Edit a.js"}});
p({type:"turn.completed",usage:{}});`,
    );
    const runner = await boot("codex-plan-1", adapterFor("codex"), {
      session: { autonomy: "edits", command: ["node", out], subagents: false, env: { CODEX_HOME: temp() } },
    });
    runner.setOptions({ permission: "plan" });
    runner.sendMessage("plan it");
    await runner.settled();
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args.find(a => a.startsWith("developer_instructions="))).toMatch(/plan mode/);
    const events = runner.store.since(0);
    expect(ofType(events, "agent_message").map(e => e.text)).toEqual(["Looking around."]);
    expect(ofType(events, "plan_proposal")).toMatchObject([{ plan: "## Plan\n1. Edit a.js" }]);
    expect(agentLoopState(events).plan).toMatchObject({ open: true });
  });
});

describe("ACP plans, usage and modes", () => {
  it("maps plan entries to a to-do snapshot and usage updates to the context meter", () => {
    const t = new AcpTranslator();
    expect(
      t.update({
        sessionUpdate: "plan",
        entries: [
          { content: "Look", status: "completed", priority: "high" },
          { content: "Fix", status: "in_progress", priority: "high" },
          { content: "", status: "pending" },
        ],
      }),
    ).toEqual([
      {
        type: "todo_snapshot",
        items: [
          { text: "Look", status: "completed" },
          { text: "Fix", status: "in_progress" },
        ],
      },
    ]);
    // As OpenCode 1.18 sends it.
    expect(t.update({ sessionUpdate: "usage_update", used: 17586, size: 200000, cost: { amount: 0, currency: "USD" } })).toEqual([
      { type: "context_usage", used: 17586, window: 200000 },
    ]);
    expect(t.update({ sessionUpdate: "usage_update", used: 5 })).toEqual([]);
  });

  it("finds the agent's own plan mode in either form", () => {
    expect(
      agentModes({
        configOptions: [
          { id: "model", category: "model", currentValue: "m" },
          { id: "mode", category: "mode", currentValue: "build", options: [{ value: "build" }, { value: "plan", name: "plan" }] },
        ],
      }),
    ).toEqual({ configId: "mode", current: "build", normal: "build", plan: "plan" });
    expect(agentModes({ modes: { currentModeId: "code", availableModes: [{ id: "code" }, { id: "architect", name: "Plan" }] } })).toEqual({
      configId: null,
      current: "code",
      normal: "code",
      plan: "architect",
    });
    expect(agentModes({ sessionId: "s" })).toBeNull();
  });

  it("asks before edits in ask mode, and only allows looking in plan mode", () => {
    const req = (kind: string) => ({
      toolCall: { kind },
      options: [
        { optionId: "y", kind: "allow_once" },
        { optionId: "n", kind: "reject_once" },
      ],
    });
    expect(needsApproval(req("edit"), "ask")).toBe(true);
    expect(needsApproval(req("read"), "ask")).toBe(false);
    expect(needsApproval(req("edit"), "edits")).toBe(false);
    expect(answerAgentRequest("session/request_permission", req("edit"), "plan")).toEqual({ result: { outcome: { outcome: "selected", optionId: "n" } } });
    expect(answerAgentRequest("session/request_permission", req("read"), "plan")).toEqual({ result: { outcome: { outcome: "selected", optionId: "y" } } });
  });

  it("in plan mode without a mode of its own, is told what plan mode means and its reply becomes the plan", async () => {
    const runner = await boot("acp-plan-1", acpAdapter("acp", ["node", join(here, "fixtures", "fake-acp-agent.mjs")]), {
      session: { autonomy: "full", env: { FAKE_ACP_CLOSING: "## Plan\n1. Fix it" } },
    });
    runner.setOptions({ permission: "plan" });
    runner.sendMessage("fix it");
    await runner.settled();
    const events = runner.store.since(0);
    expect(ofType(events, "agent_message").map(e => e.text)[0]).toMatch(/^You said: You are in plan mode[\s\S]*fix it$/);
    expect(ofType(events, "plan_proposal")).toMatchObject([{ plan: "## Plan\n1. Fix it" }]);
    // Running the tests was refused: plan mode only looks.
    expect(ofType(events, "tool_result").at(-1)?.output).toBe("permission=deny");
    expect(ofType(events, "agent_message").filter(e => e.partial)).toEqual([]);
  });
});

describe("plan hold", () => {
  it("lets everything through but the last whole message, which becomes the plan only if the turn finished", () => {
    const out: NewEvent[] = [];
    const hold = new PlanHold(e => out.push(e));
    hold.push({ type: "agent_message", text: "first", partial: false });
    hold.push({ type: "tool_call", callId: "c", name: "ls", input: {} });
    hold.push({ type: "agent_message", text: "the plan", partial: false });
    hold.end(true);
    expect(out.map(e => e.type)).toEqual(["agent_message", "tool_call", "plan_proposal"]);
    const stopped: NewEvent[] = [];
    const h2 = new PlanHold(e => stopped.push(e));
    h2.push({ type: "agent_message", text: "half a plan", partial: false });
    h2.end(false);
    expect(stopped).toEqual([{ type: "agent_message", text: "half a plan", partial: false }]);
  });
});
