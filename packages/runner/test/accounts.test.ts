import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, matchingModel, type AgentKind, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import {
  accountDir,
  accountEnv,
  accountsOf,
  addAccount,
  AgentError,
  buildHandoff,
  carrySession,
  defaultAccount,
  limitResetAt,
  loadAccounts,
  looksSignedIn,
  nextAccount,
  parseClaudeLine,
  parseClaudeStatus,
  parseCodexLine,
  parseCodexStatus,
  removeAccount,
  renameAccount,
  retryPrompt,
  setDefaultAccount,
  setOnLimit,
  ThreadRunner,
  turnFailure,
  type AgentAdapter,
  type SessionOptions,
} from "../src/index.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-accounts-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 10));
  }
};

describe("usage limits in what the agents print", () => {
  const now = new Date(2026, 10, 8, 14, 10); // local 14:10 on 8 Nov 2026

  it("Claude Code: the rate limit event, and the result line", () => {
    const state = undefined;
    const event = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1794200400 },
      session_id: "5b1c2d3e",
    });
    expect(parseClaudeLine(event, state).limitResetAt).toBe(new Date(1794200400 * 1000).toISOString());
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your limit · resets 3pm (Europe/London)",
      session_id: "5b1c2d3e",
    });
    const parsed = parseClaudeLine(result);
    expect(parsed.failure).toBe("You've hit your limit · resets 3pm (Europe/London)");
    const err = turnFailure(parsed.failure!, undefined, { resetAt: null }) as AgentError;
    expect(err.code).toBe("usage_limit");
    expect(limitResetAt(parsed.failure!, now)).toBe(new Date(2026, 10, 8, 15, 0).toISOString());
    // Weekly limits give a date.
    expect(limitResetAt("Weekly limit reached ∙ resets Nov 10, 3pm", now)).toBe(new Date(2026, 10, 10, 15, 0).toISOString());
    expect(limitResetAt("Opus weekly limit reached ∙ resets Jan 2, 9:30am", now)).toBe(new Date(2027, 0, 2, 9, 30).toISOString());
    expect(turnFailure("Claude AI usage limit reached|1794200400")).toMatchObject({ code: "usage_limit", resetAt: new Date(1794200400 * 1000).toISOString() });
  });

  it("Codex: turn.failed and error lines, with relative and dated resets", () => {
    const rel = parseCodexLine(
      JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 1 day 2 hours 5 minutes." } }),
    );
    expect(rel.failure).toMatch(/usage limit/);
    expect(turnFailure(rel.failure!)).toMatchObject({ code: "usage_limit" });
    expect(limitResetAt(rel.failure!, now)).toBe(new Date(now.getTime() + (24 * 60 + 125) * 60_000).toISOString());

    const dated = parseCodexLine(
      JSON.stringify({
        type: "error",
        message: JSON.stringify({ error: { type: "usage_limit_reached", message: "You've hit your usage limit. Try again at Nov 9th, 2026 3:05 PM." } }),
      }),
    );
    expect(dated.failure).toBe("You've hit your usage limit. Try again at Nov 9th, 2026 3:05 PM.");
    expect(limitResetAt(dated.failure!, now)).toBe(new Date(2026, 10, 9, 15, 5).toISOString());
    expect(limitResetAt("You've hit your usage limit. Try again at 4:12 PM.", now)).toBe(new Date(2026, 10, 8, 16, 12).toISOString());
    // Not every failure is a limit.
    expect(turnFailure("stream disconnected before completion")).toMatchObject({ code: "agent_failed" });
  });
});

describe("account folders", () => {
  it("adds, renames, sets the default and removes accounts, each in a folder of its own", () => {
    const home = tmp();
    expect(accountsOf(loadAccounts(home), "claude-code").map(a => a.id)).toEqual(["default"]);
    const work = addAccount(home, "claude-code", "Work");
    const personal = addAccount(home, "claude-code", "Personal");
    expect(work.id).toBe("work");
    expect(() => addAccount(home, "claude-code", "work")).toThrow(/already/);
    expect(existsSync(accountDir(home, "claude-code", work.id)!)).toBe(true);
    expect(accountDir(home, "claude-code", "default")).toBeNull();
    expect(() => accountDir(home, "claude-code", "../escape")).toThrow();
    expect(accountEnv(home, "codex", "default")).toEqual({ name: "CODEX_HOME", value: null });
    expect(accountEnv(home, "claude-code", work.id)).toEqual({ name: "CLAUDE_CONFIG_DIR", value: join(home, "accounts", "claude-code", "work") });

    setDefaultAccount(home, "claude-code", personal.id);
    expect(defaultAccount(loadAccounts(home), "claude-code")).toBe("personal");
    renameAccount(home, "claude-code", personal.id, "Side projects");
    expect(accountsOf(loadAccounts(home), "claude-code").find(a => a.id === "personal")).toMatchObject({ label: "Side projects", isDefault: true });

    removeAccount(home, "claude-code", personal.id);
    expect(existsSync(accountDir(home, "claude-code", personal.id)!)).toBe(false);
    // The default goes back to the computer's own sign-in.
    expect(defaultAccount(loadAccounts(home), "claude-code")).toBe("default");
    expect(() => removeAccount(home, "claude-code", "default")).toThrow();
    setOnLimit(home, "switch");
    expect(loadAccounts(home).onLimit).toBe("switch");
    // Codex keeps its own list.
    expect(accountsOf(loadAccounts(home), "codex")).toHaveLength(1);
  });

  it("picks the next signed-in account that hasn't hit the limit yet", () => {
    const ids = ["default", "a", "b", "c"];
    expect(nextAccount(ids, "a", new Set(["a"]))).toBe("b");
    expect(nextAccount(ids, "c", new Set(["c"]))).toBe("default");
    expect(nextAccount(ids, "a", new Set(["a", "b"]), id => id !== "c")).toBe("default");
    expect(nextAccount(ids, "a", new Set(ids))).toBeNull();
    expect(nextAccount(["default"], "default", new Set())).toBeNull();
  });

  it("tells a signed-in folder from an empty one without reading tokens", () => {
    const home = tmp();
    const claude = join(home, "c");
    mkdirSync(claude);
    expect(looksSignedIn("claude-code", claude, {}, home)).toBe(false);
    writeFileSync(join(claude, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
    expect(looksSignedIn("claude-code", claude, {}, home)).toBe(true);
    const codex = join(home, "x");
    mkdirSync(codex);
    expect(looksSignedIn("codex", codex, {}, home)).toBe(false);
    writeFileSync(join(codex, "auth.json"), "{}");
    expect(looksSignedIn("codex", codex, {}, home)).toBe(true);
    // What the agents say about themselves.
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: true, email: "me@example.com", subscriptionType: "max", authMethod: "claude.ai" }))).toEqual({
      signedIn: true,
      email: "me@example.com",
      plan: "max",
    });
    expect(parseClaudeStatus(JSON.stringify({ loggedIn: false }))).toEqual({ signedIn: false });
    expect(parseClaudeStatus("not json")).toBeNull();
    expect(parseCodexStatus("Logged in using ChatGPT\n", 0)).toEqual({ signedIn: true, plan: "ChatGPT" });
    expect(parseCodexStatus("Not logged in\n", 1)).toEqual({ signedIn: false });
  });

  it("carries a conversation's own record to another account, and nothing else", () => {
    const home = tmp();
    const from = join(home, "from");
    const to = join(home, "to");
    mkdirSync(join(from, "projects", "-work-repo"), { recursive: true });
    writeFileSync(join(from, "projects", "-work-repo", "sess-1.jsonl"), '{"type":"user"}\n');
    writeFileSync(join(from, ".credentials.json"), "secret");
    expect(carrySession("claude-code", { sessionId: "sess-1" }, from, to)).toBe(true);
    expect(readFileSync(join(to, "projects", "-work-repo", "sess-1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
    expect(existsSync(join(to, ".credentials.json"))).toBe(false);
    expect(carrySession("claude-code", { sessionId: "missing" }, from, to)).toBe(false);
    expect(carrySession("claude-code", { sessionId: "../x" }, from, to)).toBe(false);

    const day = join(from, "sessions", "2026", "11", "08");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-11-08T10-00-00-0aa1b2c3.jsonl"), "{}\n");
    writeFileSync(join(from, "auth.json"), "secret");
    expect(carrySession("codex", { threadId: "0aa1b2c3" }, from, to)).toBe(true);
    expect(existsSync(join(to, "sessions", "2026", "11", "08", "rollout-2026-11-08T10-00-00-0aa1b2c3.jsonl"))).toBe(true);
    expect(existsSync(join(to, "auth.json"))).toBe(false);
    expect(carrySession("opencode", { sessionId: "x" }, from, to)).toBe(false);
  });
});

describe("handoff to another agent", () => {
  const at = new Date().toISOString();
  let seq = 0;
  const ev = (e: Record<string, unknown>) => ({ threadId: "handoff-thread", seq: ++seq, at, ...e }) as ThreadEvent;

  it("says what was asked, what was done, which files changed and where it stopped", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", text: "Add dark mode to the settings page", clientMsgId: "m1" }),
      ev({ type: "agent_message", text: "I'll start with the theme tokens.", partial: false }),
      ev({ type: "tool_call", callId: "t1", name: "Edit", input: {} }),
      ev({ type: "file_diff", path: "src/theme.css", change: "modified", diff: "", truncated: false }),
      ev({ type: "file_diff", path: "src/Settings.tsx", change: "added", diff: "", truncated: false }),
      ev({
        type: "todo_snapshot",
        items: [
          { text: "Theme tokens", status: "completed" },
          { text: "Toggle in settings", status: "in_progress" },
        ],
      }),
      ev({ type: "user_message", text: "Also remember the choice", clientMsgId: "m2" }),
      ev({ type: "agent_message", text: "Saving the choice in local storage next.", partial: false }),
      ev({ type: "user_message", text: "Continue where you left off.", clientMsgId: "auto-continue-1" }),
    ];
    const note = buildHandoff(events, { from: "claude-code", reason: "its plan's usage limit was reached" });
    expect(note).toContain("Claude Code, which stopped because its plan's usage limit was reached");
    expect(note).toContain("## What the user asked for\n\nAdd dark mode to the settings page");
    expect(note).toContain("- Also remember the choice");
    expect(note).not.toContain("Continue where you left off.");
    expect(note).toContain("- 1 tool call");
    expect(note).toContain("- [x] Theme tokens");
    expect(note).toContain("- [ ] Toggle in settings (was in progress)");
    expect(note).toContain("- src/theme.css (modified)\n- src/Settings.tsx (added)");
    expect(note).toContain("Saving the choice in local storage next.");
  });

  it("leaves out what a rewind set aside, and copes with an empty thread", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", text: "First idea", clientMsgId: "a" }),
      ev({ type: "file_diff", path: "old.txt", change: "added", diff: "", truncated: false }),
      ev({ type: "rewind", toSeq: 1 }),
      ev({ type: "user_message", text: "Second idea", clientMsgId: "b" }),
    ];
    const note = buildHandoff(events, { from: "codex" });
    expect(note).toContain("Second idea");
    expect(note).not.toContain("First idea");
    expect(note).not.toContain("old.txt");
    expect(buildHandoff([], { from: "codex" })).toContain("No message from the user yet");
  });

  it("picks a model of the same tier", () => {
    expect(matchingModel("claude-code", "opus", "codex")).toBe("gpt-6.1-sol");
    expect(matchingModel("claude-code", "claude-haiku-4-5", "codex")).toBe("gpt-6.1-terra");
    expect(matchingModel("codex", "gpt-6-astra", "claude-code")).toBe("sonnet");
    expect(matchingModel("claude-code", null, "codex")).toBeNull();
    expect(matchingModel("claude-code", "opus", "opencode")).toBeNull();
    expect(matchingModel("codex", "gpt-6.1-sol", "claude-code", { from: [{ id: "a" }, { id: "gpt-6.1-sol" }] })).toBe("sonnet");
  });
});

function thread(id: string, agent: AgentKind = "claude-code"): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: agent },
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

/**
 * A fake agent whose accounts (config folders) have hit their limit or not. It records
 * every turn: the prompt, the folder it ran with and the conversation it resumed.
 */
function fakeAgents(limited: Set<string>) {
  const turns: { kind: AgentKind; prompt: string; dir: string | undefined; resumed: string | undefined }[] = [];
  const make = (kind: AgentKind): AgentAdapter => ({
    kind,
    createSession: (opts: SessionOptions) => {
      let id = opts.saved?.sessionId;
      const dir = opts.env?.CLAUDE_CONFIG_DIR ?? opts.env?.CODEX_HOME;
      return {
        runTurn: async ctx => {
          turns.push({ kind, prompt: ctx.prompt, dir, resumed: id });
          id ??= `sess-${turns.length}`;
          if (dir) {
            mkdirSync(join(dir, "projects", "-repo"), { recursive: true });
            writeFileSync(join(dir, "projects", "-repo", `${id}.jsonl`), "{}\n");
          }
          if (limited.has(dir ?? `${kind}:default`)) throw new AgentError("You've hit your limit · resets 3pm", "usage_limit");
        },
        saveState: () => (id ? { sessionId: id } : {}),
        dispose: async () => {},
      };
    },
  });
  return { turns, make };
}

async function limitedRunner(o: { onLimit: "wait" | "switch" | "ask"; limited: (home: string) => Set<string>; dataDir?: string; id?: string }) {
  const home = tmp();
  const a = addAccount(home, "claude-code", "Work");
  const b = addAccount(home, "claude-code", "Personal");
  setDefaultAccount(home, "claude-code", a.id);
  const limited = o.limited(home);
  const agents = fakeAgents(limited);
  const runner = new ThreadRunner({
    thread: thread(o.id ?? "switch-thread-1"),
    workdir: "/tmp",
    dataDir: o.dataDir ?? null,
    adapter: agents.make("claude-code"),
    adapterFor: agents.make,
    session: { autonomy: "edits" },
    git: false,
    bundledSkills: false,
    accountsHome: home,
    onLimit: () => o.onLimit,
    accountSignedIn: () => true,
    signedInAgents: () => ["claude-code", "codex"],
    limitMinWaitMs: 60_000,
  });
  await runner.init();
  return { runner, home, a, b, limited, agents };
}

const ofType = <T extends ThreadEvent["type"]>(runner: ThreadRunner, type: T) =>
  runner.store.since(0).filter((e): e is Extract<ThreadEvent, { type: T }> => e.type === type);

describe("carrying a thread on past a usage limit", () => {
  it("asks first, then switches account and carries the same conversation on", async () => {
    const { runner, home, a, b, agents } = await limitedRunner({
      onLimit: "ask",
      limited: home => new Set([accountDir(home, "claude-code", "work")!]),
    });
    runner.sendMessage("Add dark mode");
    await runner.settled();
    const [hit] = ofType(runner, "limit_hit");
    expect(hit).toMatchObject({ agent: "claude-code", account: { id: a.id, label: "Work" }, agents: ["codex"] });
    expect(hit!.accounts.map(x => x.id)).toEqual(["default", b.id]);
    // Asked, so nothing waits for the reset.
    expect(runner.usageLimited).toBeNull();
    expect(runner.limitStopped).toMatchObject({ agent: "claude-code", account: a.id });

    expect(await runner.limitAction({ action: "switch_account", accountId: b.id })).toEqual({ ok: true });
    await until(() => agents.turns.length === 2);
    await runner.settled();
    const [sw] = ofType(runner, "agent_switch");
    expect(sw).toMatchObject({ from: { account: { id: a.id } }, to: { agent: "claude-code", account: { id: b.id } }, carried: "session", auto: false });
    const second = agents.turns[1]!;
    expect(second.dir).toBe(accountDir(home, "claude-code", b.id));
    expect(second.resumed).toBe("sess-1");
    expect(second.prompt).toBe(retryPrompt("Add dark mode", "usage_limit"));
    expect(existsSync(join(second.dir!, "projects", "-repo", "sess-1.jsonl"))).toBe(true);
    expect(runner.limitStopped).toBeNull();
    expect(runner.currentAccount).toBe(b.id);
    await runner.close();
  });

  it("switches to the next account by itself, and waits once every account is out", async () => {
    const { runner, home, agents } = await limitedRunner({
      onLimit: "switch",
      limited: home => new Set([accountDir(home, "claude-code", "work")!, accountDir(home, "claude-code", "personal")!, "claude-code:default"]),
      id: "switch-thread-2",
    });
    void home;
    runner.sendMessage("Fix the tests");
    await until(() => agents.turns.length === 3);
    await until(() => runner.usageLimited !== null);
    await runner.settled();
    const switches = ofType(runner, "agent_switch");
    expect(switches.map(s => [s.to.account?.id, s.auto])).toEqual([
      ["personal", true],
      ["default", true],
    ]);
    expect(ofType(runner, "limit_hit")).toHaveLength(3);
    const notices = ofType(runner, "notice").map(n => n.code);
    expect(notices).toContain("no_account_to_switch");
    expect(notices).toContain("usage_limited");
    expect(agents.turns.map(t => t.prompt)).toEqual([
      "Fix the tests",
      retryPrompt("Fix the tests", "usage_limit"),
      retryPrompt("Fix the tests", "usage_limit"),
    ]);
    await runner.close();
  });

  it("moves to another agent with a handoff note, and stays on it after a restart", async () => {
    const dataDir = tmp();
    const { runner, agents } = await limitedRunner({
      onLimit: "wait",
      limited: home => new Set([accountDir(home, "claude-code", "work")!]),
      dataDir,
      id: "switch-thread-3",
    });
    runner.sendMessage("Write the release notes");
    await runner.settled();
    expect(runner.usageLimited).not.toBeNull();
    expect(await runner.limitAction({ action: "switch_agent", agent: "codex", model: "gpt-6.1-sol" })).toEqual({ ok: true });
    await until(() => agents.turns.length === 2);
    await runner.settled();
    // The wait for the reset is off: the new agent carried on.
    expect(runner.usageLimited).toBeNull();
    const second = agents.turns[1]!;
    expect(second.kind).toBe("codex");
    expect(second.resumed).toBeUndefined();
    expect(second.prompt).toContain("Handoff from LemonLime");
    expect(second.prompt).toContain("Write the release notes");
    expect(ofType(runner, "agent_switch")[0]).toMatchObject({
      from: { agent: "claude-code" },
      to: { agent: "codex", model: "gpt-6.1-sol" },
      carried: "handoff",
    });
    expect(runner.thread.agent).toEqual({ kind: "codex", model: "gpt-6.1-sol" });
    expect(runner.currentOptions.model).toBe("gpt-6.1-sol");
    expect(await runner.limitAction({ action: "switch_agent", agent: "codex", model: null })).toEqual({ error: "The thread already uses that agent." });
    await runner.close();

    // Started again as it was first set up, it carries on with Codex.
    const again = fakeAgents(new Set());
    const restarted = new ThreadRunner({
      thread: thread("switch-thread-3"),
      workdir: "/tmp",
      dataDir,
      adapter: again.make("claude-code"),
      adapterFor: again.make,
      session: { autonomy: "edits" },
      git: false,
      bundledSkills: false,
    });
    await restarted.init();
    expect(restarted.thread.agent.kind).toBe("codex");
    restarted.sendMessage("Thanks");
    await restarted.settled();
    expect(again.turns[0]).toMatchObject({ kind: "codex", resumed: "sess-2" });
    await restarted.close();
  });

  it("refuses what can't be done", async () => {
    const { runner } = await limitedRunner({ onLimit: "ask", limited: () => new Set(), id: "switch-thread-4" });
    expect(await runner.limitAction({ action: "wait" })).toEqual({ error: "This thread isn't stopped on a usage limit." });
    expect(await runner.limitAction({ action: "switch_account", accountId: "nope" })).toMatchObject({ error: expect.stringMatching(/no such account/) });
    expect(await runner.limitAction({ action: "switch_account", accountId: "work" })).toEqual({ error: "The thread already uses that account." });
    expect(await runner.limitAction({ action: "switch_agent", agent: "acp", model: null })).toMatchObject({ error: expect.any(String) });
    await runner.close();
    // Cloud threads keep one sign-in.
    const cloud = new ThreadRunner({
      thread: thread("switch-thread-5"),
      workdir: "/tmp",
      dataDir: null,
      adapter: fakeAgents(new Set()).make("claude-code"),
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
    });
    await cloud.init();
    expect(await cloud.limitAction({ action: "switch_account", accountId: "work" })).toEqual({ error: "Switching accounts isn't available for this thread." });
    await cloud.close();
  });
});
