import { describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { createRedactor, secretsFromEnv, ThreadRunner, type AgentAdapter } from "../src/index.ts";

describe("secret redaction", () => {
  it("replaces values anywhere in an event, longest first, and leaves short ones alone", () => {
    const redact = createRedactor({ NPM_TOKEN: "npm_abc123secret", API: "abc123", PIN: "1234" });
    const out = redact({ type: "tool_result", callId: "c", output: { log: ["using npm_abc123secret", "abc123 again", "pin 1234"] }, isError: false });
    expect(out).toEqual({ type: "tool_result", callId: "c", output: { log: ["using [secret NPM_TOKEN]", "[secret API] again", "pin 1234"] }, isError: false });
  });

  it("hides a secret's new value after it changes under the same name (signing in again)", () => {
    const secrets: Record<string, string> = { CLAUDE_TOKEN: "sk-old-token-0001" };
    const redact = createRedactor(secrets);
    const msg = (text: string) => redact({ type: "agent_message", text }) as { text: string };
    expect(msg("sk-old-token-0001").text).toBe("[secret CLAUDE_TOKEN]");
    secrets.CLAUDE_TOKEN = "sk-new-token-0002";
    expect(msg("sk-new-token-0002").text).toBe("[secret CLAUDE_TOKEN]");
  });

  it("reads the secret names from LEMONLIME_REDACT_ENV", () => {
    expect(secretsFromEnv({ LEMONLIME_REDACT_ENV: "A, B,C", A: "value-a", B: "value-b" })).toEqual({ A: "value-a", B: "value-b" });
    expect(secretsFromEnv({})).toEqual({});
    expect(secretsFromEnv({ LEMONLIME_THREAD_SECRET: "thread-secret-value" })).toEqual({ LEMONLIME_THREAD_SECRET: "thread-secret-value" });
  });

  it("keeps secrets out of the thread's history", async () => {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "redact-thread",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread("redact-thread"),
      mode: "cloud",
      status: "provisioning",
      sandboxSize: "small",
      latestSeq: 0,
      mine: true,
      shared: false,
      createdAt: now,
      updatedAt: now,
    };
    const leaky: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async ctx => {
          ctx.emit({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "echo $DEPLOY_KEY" } });
          ctx.emit({ type: "tool_result", callId: "c1", output: "sk-deploy-0123456789\n", isError: false });
          ctx.emit({ type: "agent_message", text: "The key is sk-deploy-0123456789." });
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = new ThreadRunner({
      thread,
      workdir: process.cwd(),
      dataDir: null,
      adapter: leaky,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
      redact: { DEPLOY_KEY: "sk-deploy-0123456789" },
    });
    await runner.init();
    runner.sendMessage("my key is sk-deploy-0123456789, use it");
    await runner.settled();
    await runner.close();
    const text = JSON.stringify(runner.store.since(0));
    expect(text).not.toContain("sk-deploy-0123456789");
    expect(text).toContain("[secret DEPLOY_KEY]");
  });
});
