import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { ThreadRunner, writeAgentFiles, type AgentAdapter, type AgentCredential, type LoginUpdate } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-login-"));
  dirs.push(d);
  return d;
};

/** A pretend `claude setup-token`: prints a link, asks for the code, prints a token. */
function fakeClaudeLogin(dir: string, exitCode = 0): string[] {
  const script = join(dir, "fake-login.mjs");
  writeFileSync(
    script,
    `process.stdout.write("Opening browser to sign in...\\nIf the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc\\n");
process.stdout.write("Paste code here if prompted > ");
process.stdin.once("data", d => {
  if (${exitCode} !== 0) { process.stderr.write("Invalid code\\n"); process.exit(${exitCode}); }
  process.stdout.write("\\nYour OAuth token (valid for 1 year):\\n\\nsk-ant-oat01-" + "A".repeat(40) + "\\n");
  process.exit(0);
});`,
  );
  return [process.execPath, script];
}

function thread(id: string): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "cloud",
    status: "provisioning",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const echoing: AgentAdapter = {
  kind: "claude-code",
  createSession: () => ({
    runTurn: async ctx => ctx.emit({ type: "agent_message", text: `token is ${process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "unset"}` }),
    saveState: () => ({}),
    dispose: async () => {},
  }),
};

async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

describe("signing an agent in", () => {
  it("shows the link, takes the pasted code, keeps the token, and never records any of it", async () => {
    const dir = temp();
    const saved: AgentCredential[] = [];
    const runner = new ThreadRunner({
      thread: thread("login-thread-1"),
      workdir: dir,
      dataDir: null,
      adapter: echoing,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
      loginCommand: fakeClaudeLogin(dir),
      onAgentCredential: async c => void saved.push(c),
    });
    await runner.init();
    const updates: LoginUpdate[] = [];
    runner.onLogin(u => updates.push(u));
    runner.startLogin();
    await until(() => updates.some(u => u.state === "needs_input"));
    expect(updates.find(u => u.state === "open_url")?.url).toBe("https://claude.ai/oauth/authorize?code=true&state=abc");
    runner.loginInput("the-code-from-the-page");
    await until(() => updates.some(u => u.state === "done"));
    await until(() => saved.length === 1);
    expect(saved[0]).toEqual({ kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN", value: `sk-ant-oat01-${"A".repeat(40)}` });

    // The next turn uses the token, and its value never reaches history.
    runner.sendMessage("hi");
    await runner.settled();
    const history = JSON.stringify(runner.store.since(0));
    expect(history).toContain("token is [secret CLAUDE_CODE_OAUTH_TOKEN]");
    expect(history).not.toContain("sk-ant-oat01");
    expect(history).not.toContain("the-code-from-the-page");
    expect(history).not.toContain("claude.ai/oauth");
    await runner.close();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it("says when sign-in fails", async () => {
    const dir = temp();
    const runner = new ThreadRunner({
      thread: thread("login-thread-2"),
      workdir: dir,
      dataDir: null,
      adapter: echoing,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
      loginCommand: fakeClaudeLogin(dir, 1),
    });
    await runner.init();
    const updates: LoginUpdate[] = [];
    runner.onLogin(u => updates.push(u));
    runner.startLogin();
    await until(() => updates.some(u => u.state === "needs_input"));
    runner.loginInput("wrong");
    await until(() => updates.some(u => u.state === "failed"));
    expect(updates.at(-1)?.message).toMatch(/Invalid code/);
    await runner.close();
  });
});

describe("credential files for a new sandbox", () => {
  it("are written privately under home, never outside it, and the variable is removed", () => {
    const home = temp();
    const env: NodeJS.ProcessEnv = {
      LEMONLIME_AGENT_FILES: Buffer.from(
        JSON.stringify({ ".codex/auth.json": '{"tokens":{"access_token":"eyJhbGciOiJ-access-token-value"}}', "../escape": "x", "/etc/passwd": "x" }),
      ).toString("base64"),
    };
    const written = writeAgentFiles(env, home);
    expect(written.map(c => c.name)).toEqual([".codex/auth.json"]);
    expect(readFileSync(join(home, ".codex/auth.json"), "utf8")).toContain("access-token-value");
    expect(statSync(join(home, ".codex/auth.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "..", "escape"))).toBe(false);
    expect(env.LEMONLIME_AGENT_FILES).toBeUndefined();
  });
});
