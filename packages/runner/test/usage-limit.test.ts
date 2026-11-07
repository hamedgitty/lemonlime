import { describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import {
  AgentError,
  classifyAgentFailure,
  CONTINUE_AFTER_LIMIT,
  limitResetAt,
  parseClaudeLine,
  ThreadRunner,
  turnFailure,
  type AgentAdapter,
} from "../src/index.ts";

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
    createdAt: now,
    updatedAt: now,
  };
}
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 10));
  }
};

describe("usage limits", () => {
  it("knows a usage limit when it sees one, and when it lifts", () => {
    const now = new Date(2026, 10, 7, 14, 10); // local 14:10
    expect(classifyAgentFailure("Claude AI usage limit reached|1794081600")).toBe("usage_limit");
    expect(classifyAgentFailure("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.")).toBe("usage_limit");
    expect(classifyAgentFailure("Not logged in")).toBe("auth_required");
    expect(limitResetAt("Claude AI usage limit reached|1794081600", now)).toBe(new Date(1794081600 * 1000).toISOString());
    expect(limitResetAt("try again in 2 hours 5 minutes", now)).toBe(new Date(now.getTime() + 125 * 60_000).toISOString());
    expect(limitResetAt("5-hour limit reached ∙ resets 3pm", now)).toBe(new Date(2026, 10, 7, 15, 0).toISOString());
    expect(limitResetAt("limit reached, resets at 9:30 am", now)).toBe(new Date(2026, 10, 8, 9, 30).toISOString()); // tomorrow
    expect(limitResetAt("usage limit reached", now)).toBeNull();
    // Claude says so in its own event, before the turn fails.
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1794081600 } });
    expect(parseClaudeLine(line).limitResetAt).toBe(new Date(1794081600 * 1000).toISOString());
    const err = turnFailure("Something went wrong", undefined, { resetAt: "2026-11-07T15:00:00.000Z" }) as AgentError;
    expect([err.code, err.resetAt]).toEqual(["usage_limit", "2026-11-07T15:00:00.000Z"]);
  });

  it("continues on its own once the limit lifts, at most three times a day", async () => {
    const prompts: string[] = [];
    let limited = true;
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async ctx => {
          prompts.push(ctx.prompt);
          if (limited) throw new AgentError("Claude AI usage limit reached", "usage_limit", new Date(Date.now() - 120_000).toISOString());
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = new ThreadRunner({
      thread: thread("limit-thread-1"),
      workdir: "/tmp",
      dataDir: null,
      adapter,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
      limitMinWaitMs: 20,
    });
    await runner.init();
    runner.sendMessage("build the thing");
    await until(() => prompts.length === 4);
    await runner.settled();
    // The first message, then three automatic continues, then it stops and says so.
    expect(prompts).toEqual(["build the thing", CONTINUE_AFTER_LIMIT, CONTINUE_AFTER_LIMIT, CONTINUE_AFTER_LIMIT]);
    await new Promise(r => setTimeout(r, 100));
    expect(prompts).toHaveLength(4);
    const notices = runner.store
      .since(0)
      .filter(e => e.type === "notice")
      .map(e => (e as { code: string }).code);
    expect(notices.filter(c => c === "usage_limited")).toHaveLength(3);
    expect(notices.at(-1)).toBe("usage_limit_no_retry");
    expect(runner.usageLimited).toBeNull();
    await runner.close();
  });

  it("doesn't continue on its own once the user writes, and does at once after a fresh sign-in", async () => {
    const prompts: string[] = [];
    let limited = true;
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async ctx => {
          prompts.push(ctx.prompt);
          if (limited) throw new AgentError("usage limit reached", "usage_limit", new Date(Date.now() + 3_600_000).toISOString());
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = new ThreadRunner({
      thread: thread("limit-thread-2"),
      workdir: "/tmp",
      dataDir: null,
      adapter,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
    });
    await runner.init();
    runner.sendMessage("first");
    await runner.settled();
    expect(runner.usageLimited?.resetAt).toBeTruthy();
    limited = false;
    runner.useCredential({ kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-another-account-token" });
    await until(() => prompts.length === 2);
    expect(prompts[1]).toBe(CONTINUE_AFTER_LIMIT);
    await runner.settled();
    expect(runner.usageLimited).toBeNull();
    await runner.close();
  });
});
