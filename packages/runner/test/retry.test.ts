import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { AgentError, retryPrompt, ThreadRunner, type AgentAdapter, type ThreadRunnerOptions } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

function thread(id: string): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "local",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    mine: true,
    shared: false,
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

/** An agent that fails with `failure()` while it returns an error, and records every prompt. */
function flaky(failure: () => AgentError | null) {
  const prompts: string[] = [];
  const adapter: AgentAdapter = {
    kind: "claude-code",
    createSession: () => ({
      runTurn: async ctx => {
        prompts.push(ctx.prompt);
        const err = failure();
        if (err) throw err;
        ctx.emit({ type: "agent_message", text: "done", partial: false });
      },
      saveState: () => ({}),
      dispose: async () => {},
    }),
  };
  return { prompts, adapter };
}

const overloaded = () => new AgentError("Overloaded", "overloaded", new Date().toISOString());

function runner(id: string, adapter: AgentAdapter, extra: Partial<ThreadRunnerOptions> = {}) {
  return new ThreadRunner({
    thread: thread(id),
    workdir: "/tmp",
    dataDir: null,
    adapter,
    session: { autonomy: "full" },
    git: false,
    bundledSkills: false,
    retryMaxWaitMs: 60_000,
    retryMinWaitMs: 20,
    ...extra,
  });
}

const notices = (r: ThreadRunner) =>
  r.store
    .since(0)
    .filter(e => e.type === "notice")
    .map(e => (e as { code: string }).code);

describe("automatic retry", () => {
  it("runs a turn again after the provider was overloaded, saying when", async () => {
    let failures = 2;
    const { prompts, adapter } = flaky(() => (failures-- > 0 ? overloaded() : null));
    const r = runner("retry-thread-1", adapter);
    await r.init();
    r.sendMessage("fix the bug");
    await until(() => prompts.length === 3);
    await r.settled();
    expect(prompts).toEqual(["fix the bug", retryPrompt("fix the bug", "overloaded"), retryPrompt("fix the bug", "overloaded")]);
    const events = r.store.since(0);
    expect(events.filter(e => e.type === "user_message")).toHaveLength(1); // the same message, not a new one
    const scheduled = events.find(e => e.type === "notice" && e.code === "retry_scheduled");
    expect(scheduled).toMatchObject({ untilAt: expect.any(String) });
    expect(notices(r).filter(c => c === "retry_started")).toHaveLength(2);
    expect(r.pendingRetry).toBeNull();
    await r.close();
  });

  it("is off unless a max wait is given (a busy provider is then just an error)", async () => {
    const { prompts, adapter } = flaky(overloaded);
    const r = runner("retry-thread-2", adapter, { retryMaxWaitMs: 0 });
    await r.init();
    r.sendMessage("hello");
    await r.settled();
    await new Promise(res => setTimeout(res, 80));
    expect(prompts).toHaveLength(1);
    expect(r.store.since(0).find(e => e.type === "error")).toMatchObject({ code: "overloaded" });
    await r.close();
  });

  it("stops waiting when the user sends a message or stops the agent", async () => {
    const { prompts, adapter } = flaky(() =>
      prompts.length === 1 ? new AgentError("Overloaded", "overloaded", new Date(Date.now() + 60_000).toISOString()) : null,
    );
    const r = runner("retry-thread-3", adapter);
    await r.init();
    r.sendMessage("first");
    await r.settled();
    expect(r.pendingRetry?.reason).toBe("overloaded");
    r.sendMessage("never mind, do this");
    await r.settled();
    expect(prompts).toEqual(["first", "never mind, do this"]);
    expect(r.pendingRetry).toBeNull();
    expect(notices(r)).toContain("retry_cancelled");
    await r.close();

    const second = flaky(() => new AgentError("Overloaded", "overloaded", new Date(Date.now() + 60_000).toISOString()));
    const r2 = runner("retry-thread-4", second.adapter);
    await r2.init();
    r2.sendMessage("first");
    await r2.settled();
    expect(r2.pendingRetry).not.toBeNull();
    r2.interrupt();
    expect(r2.pendingRetry).toBeNull();
    await r2.close();
  });

  it("gives up when a limit lifts later than it may wait, or once the wait is used up", async () => {
    const late = flaky(() => new AgentError("usage limit reached", "usage_limit", new Date(Date.now() + 3 * 3_600_000).toISOString()));
    const r = runner("retry-thread-5", late.adapter, { retryMaxWaitMs: 30 * 60_000 });
    await r.init();
    r.sendMessage("big job");
    await r.settled();
    expect(r.pendingRetry).toBeNull();
    expect(r.usageLimited).toBeNull(); // the plain continue-after-reset isn't used on top
    expect(r.store.since(0).find(e => e.type === "notice" && e.code === "retry_given_up")).toMatchObject({ message: expect.stringMatching(/3 hours/) });
    await r.close();

    // No time given: the first wait is cut to what's left, and then there's nothing left.
    const busy = flaky(() => new AgentError("Overloaded", "overloaded"));
    const r2 = runner("retry-thread-6", busy.adapter, { retryMaxWaitMs: 100, retryMinWaitMs: 20 });
    await r2.init();
    r2.sendMessage("go");
    await until(() => notices(r2).includes("retry_given_up"));
    expect(busy.prompts).toHaveLength(2);
    await r2.close();
  });

  it("keeps a waiting retry across a runner restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lemonlime-retry-"));
    dirs.push(dataDir);
    const first = flaky(() => new AgentError("Overloaded", "overloaded", new Date(Date.now() + 300).toISOString()));
    const r = runner("retry-thread-7", first.adapter, { dataDir });
    await r.init();
    r.sendMessage("persist me");
    await r.settled();
    expect(r.pendingRetry).not.toBeNull();
    await r.close();

    const second = flaky(() => null);
    const r2 = runner("retry-thread-7", second.adapter, { dataDir });
    await r2.init();
    await until(() => second.prompts.length === 1);
    await r2.settled();
    expect(second.prompts[0]).toBe(retryPrompt("persist me", "overloaded"));
    expect(r2.pendingRetry).toBeNull();
    await r2.close();
  });
});
