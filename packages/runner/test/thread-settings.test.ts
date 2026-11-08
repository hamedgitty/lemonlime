import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type AgentKind, type Thread } from "@lemonlime/protocol";
import {
  acpAdapter,
  adapterFor,
  blockedCommand,
  capBytes,
  classifyAgentFailure,
  gitConfigParameters,
  installSkills,
  readInstructions,
  retryAfterAt,
  threadBranch,
  ThreadRunner,
  tomlString,
  turnFailure,
  writeUserSkills,
  type AgentError,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-settings-"));
  dirs.push(d);
  return d;
};
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir })
    .toString()
    .trim();

function repo(): string {
  const dir = temp();
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

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

/** Run one turn of a real adapter whose CLI is print-args.mjs; returns what it was started with. */
async function argsFor(kind: "claude-code" | "codex", session: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof ThreadRunner>[0]> = {}) {
  const out = join(temp(), "args.json");
  const runner = new ThreadRunner({
    thread: thread(`args-${kind}-1`, kind),
    workdir: temp(),
    dataDir: null,
    adapter: adapterFor(kind),
    session: { autonomy: "full", command: ["node", join(here, "fixtures", "print-args.mjs")], env: { ARGS_OUT: out }, subagents: false, ...session },
    git: false,
    bundledSkills: false,
    ...extra,
  });
  await runner.init();
  runner.sendMessage("hello");
  await runner.settled();
  await runner.close();
  return JSON.parse(readFileSync(out, "utf8")) as { args: string[]; stdin: string | null; gitConfig: string | null };
}

describe("prompts", () => {
  it("reach Claude Code and Codex on stdin, never as a flag", async () => {
    for (const kind of ["claude-code", "codex"] as const) {
      const out = join(temp(), "args.json");
      const runner = new ThreadRunner({
        thread: thread(`prompt-${kind}-1`, kind),
        workdir: temp(),
        dataDir: null,
        adapter: adapterFor(kind),
        session: { autonomy: "full", command: ["node", join(here, "fixtures", "print-args.mjs")], env: { ARGS_OUT: out }, subagents: false },
        git: false,
        bundledSkills: false,
      });
      await runner.init();
      runner.sendMessage("--help me fix the build");
      await runner.settled();
      const first = JSON.parse(readFileSync(out, "utf8")) as { args: string[]; stdin: string | null };
      expect(first.stdin, kind).toBe("--help me fix the build");
      expect(first.args, kind).not.toContain("--help me fix the build");
      if (kind === "codex") expect(first.args.at(-1)).toBe("-");
      else expect(first.args[first.args.indexOf("-p") + 1]).toBe("--output-format");

      // Far past what one command-line argument may hold on Linux (128 KiB).
      const long = `- ${"word ".repeat(60_000)}`;
      runner.sendMessage(long);
      await runner.settled();
      const second = JSON.parse(readFileSync(out, "utf8")) as { args: string[]; stdin: string | null };
      expect(second.stdin?.length, kind).toBe(long.length);
      expect(second.args.join(" ").length, kind).toBeLessThan(20_000);
      await runner.close();
    }
  });
});

describe("custom instructions", () => {
  it("join Claude Code's system prompt and Codex's developer instructions", async () => {
    const claude = await argsFor("claude-code", { instructions: "Always write tests." });
    expect(claude.args[claude.args.indexOf("--append-system-prompt") + 1]).toBe("Always write tests.");
    const codex = await argsFor("codex", { instructions: 'Say "hi"\nthen stop.' });
    expect(codex.args).toContain(`developer_instructions="Say \\"hi\\"\\nthen stop."`);
    const none = await argsFor("claude-code", {});
    expect(none.args).not.toContain("--append-system-prompt");
  });

  it("start each new ACP conversation", async () => {
    const runner = new ThreadRunner({
      thread: thread("acp-instr-1", "acp"),
      workdir: temp(),
      dataDir: null,
      adapter: acpAdapter("acp", ["node", join(here, "fixtures", "fake-acp-agent.mjs")]),
      session: { autonomy: "full", instructions: "Reply in French." },
      git: false,
      bundledSkills: false,
    });
    await runner.init();
    runner.sendMessage("one");
    await runner.settled();
    runner.sendMessage("two");
    await runner.settled();
    const said = runner.store
      .since(0)
      .filter(e => e.type === "agent_message" && !e.partial)
      .map(e => (e as { text: string }).text);
    expect(said[0]).toMatch(/^You said: Instructions from the user[\s\S]*Reply in French\.[\s\S]*one$/);
    expect(said[1]).toBe("You said: two");
    await runner.close();
  });

  it("are read from a file or the environment, and capped at 32 KB", () => {
    const file = join(temp(), "instructions.md");
    writeFileSync(file, "From the file");
    const env: NodeJS.ProcessEnv = { LEMONLIME_INSTRUCTIONS: "From the env" };
    expect(readInstructions(file, env)).toEqual({ text: "From the file", cut: false });
    expect(env.LEMONLIME_INSTRUCTIONS).toBeUndefined(); // the agent never sees the variable
    expect(readInstructions(undefined, { LEMONLIME_INSTRUCTIONS: "From the env" })?.text).toBe("From the env");
    expect(readInstructions(undefined, {})).toBeNull();
    const long = readInstructions(undefined, { LEMONLIME_INSTRUCTIONS: "é".repeat(20_000) })!;
    expect([Buffer.byteLength(long.text) <= 32 * 1024, long.cut]).toEqual([true, true]);
    expect(capBytes("aé", 2)).toBe("a"); // never half a character
  });
});

describe("the command guard", () => {
  it("refuses dangerous commands an ACP agent asks to run, at any autonomy", async () => {
    for (const autonomy of ["full", "edits"] as const) {
      const runner = new ThreadRunner({
        thread: thread(`acp-guard-${autonomy}`, "acp"),
        workdir: temp(),
        dataDir: null,
        adapter: acpAdapter("acp", ["node", join(here, "fixtures", "fake-acp-agent.mjs")]),
        session: { autonomy, env: { FAKE_ACP_COMMAND: "rm -rf ~" } },
        git: false,
        bundledSkills: false,
      });
      await runner.init();
      runner.sendMessage("clean up");
      await runner.settled();
      const events = runner.store.since(0);
      expect(events.find(e => e.type === "tool_result")).toMatchObject({ output: "permission=deny" });
      expect(events.find(e => e.type === "notice" && e.code === "command_blocked")).toBeDefined();
      expect(events.find(e => e.type === "approval_request")).toBeUndefined(); // nobody is asked
      await runner.close();
    }
  });

  it("can be turned off for ACP agents too", async () => {
    const runner = new ThreadRunner({
      thread: thread("acp-guard-off", "acp"),
      workdir: temp(),
      dataDir: null,
      adapter: acpAdapter("acp", ["node", join(here, "fixtures", "fake-acp-agent.mjs")]),
      session: { autonomy: "full", commandGuard: false, env: { FAKE_ACP_COMMAND: "rm -rf ~" } },
      git: false,
      bundledSkills: false,
    });
    await runner.init();
    runner.sendMessage("clean up");
    await runner.settled();
    expect(runner.store.since(0).find(e => e.type === "tool_result")).toMatchObject({ output: "permission=allow" });
    await runner.close();
  });

  it("reads commands as strings or argument lists", () => {
    expect(blockedCommand({ toolCall: { rawInput: { command: ["sudo", "rm", "-rf", "/"] } } })).toMatch(/system files/);
    expect(blockedCommand({ toolCall: { rawInput: { command: "npm test" } } })).toBeNull();
    expect(blockedCommand({ toolCall: {} })).toBeNull();
  });

  it("is still passed to Claude Code, and left out when turned off", async () => {
    expect((await argsFor("claude-code", {})).args).toContain("--settings");
    expect((await argsFor("claude-code", { commandGuard: false })).args).not.toContain("--settings");
  });
});

describe("fast mode and effort", () => {
  it("reach Claude Code as --effort and a fastMode setting", async () => {
    const { args } = await argsFor("claude-code", { reasoning: "xhigh", fast: true, commandGuard: false });
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "xhigh"]);
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ fastMode: true });
  });

  it("keep the command guard in the same Claude Code settings", async () => {
    const { args } = await argsFor("claude-code", { fast: true });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as { fastMode?: boolean; hooks?: unknown };
    expect(settings.fastMode).toBe(true);
    expect(settings.hooks).toBeDefined();
    expect(args.filter(a => a === "--settings")).toHaveLength(1);
  });

  it("reach Codex as its fast service tier, and are left out when off", async () => {
    expect((await argsFor("codex", { fast: true })).args).toContain('service_tier="fast"');
    expect((await argsFor("codex", {})).args).not.toContain('service_tier="fast"');
  });
});

describe("stripping co-author trailers", () => {
  it("removes them from the agent's commits in the thread only, and keeps the repo's own hooks", async () => {
    const source = repo();
    // The repository's own commit-msg hook still runs.
    const hooks = join(source, ".git", "hooks");
    writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\necho "Checked-by: repo hook" >> "$1"\n', { mode: 0o755 });
    const home = temp();
    const workdir = join(home, "wt");
    const committing = {
      kind: "claude-code" as const,
      createSession: (opts: { cwd: string; env?: Record<string, string> }) => ({
        async runTurn() {
          writeFileSync(join(opts.cwd, "b.txt"), "b\n");
          execFileSync("git", ["add", "b.txt"], { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
          execFileSync(
            "git",
            ["-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "Add b\n\nCo-Authored-By: Some Bot <bot@example.com>\nco-authored-by: other <o@o>"],
            {
              cwd: opts.cwd,
              env: { ...process.env, ...opts.env },
            },
          );
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = new ThreadRunner({
      thread: thread("coauthor-1"),
      workdir,
      dataDir: join(home, "data"),
      adapter: committing,
      session: { autonomy: "full" },
      sourceRepo: source,
      bundledSkills: false,
      stripCoauthors: true,
    });
    await runner.init();
    runner.sendMessage("add b");
    await runner.settled();
    await runner.close();
    const message = git(workdir, "log", "-1", "--format=%B");
    expect(message).toContain("Add b");
    expect(message).toContain("Checked-by: repo hook");
    expect(message.toLowerCase()).not.toContain("co-authored-by");
    // The user's own checkout keeps git's defaults: no hooksPath was set anywhere.
    expect(() => git(source, "config", "--get", "core.hooksPath")).toThrow(); // exits 1: not set
    expect(readFileSync(join(source, ".git", "config"), "utf8")).not.toContain("hooks");
  }, 30_000);

  it("only point the agent's git at the hooks when asked", async () => {
    expect((await argsFor("claude-code", {})).gitConfig).toBeNull();
    const out = await argsFor("claude-code", {}, { stripCoauthors: true, git: true, workdir: repo() });
    expect(out.gitConfig).toMatch(/^'core\.hooksPath=.*git-hooks|lemonlime-hooks-.*'$/);
    expect(gitConfigParameters({ "core.hooksPath": "/x y/it's" }, "'a.b=c'")).toBe(`'a.b=c' 'core.hooksPath=/x y/it'\\''s'`);
  });
});

describe("branch prefixes", () => {
  it("name new threads with the prefix, and keep old threads on their branch", () => {
    const data = temp();
    expect(threadBranch(join(data, "new"), "thread-111", "ai/")).toBe("ai/thread-111");
    expect(threadBranch(join(data, "new"), "thread-111", "other/")).toBe("ai/thread-111"); // it keeps its branch
    mkdirSync(join(data, "old"));
    writeFileSync(join(data, "old", "state.json"), "{}");
    expect(threadBranch(join(data, "old"), "thread-222", "ai/")).toBe("agent/thread-222");
    expect(threadBranch(join(data, "plain"), "thread-333", undefined)).toBe("agent/thread-333");
    expect(existsSync(join(data, "plain"))).toBe(false); // nothing written for the default
  });
});

describe("the sandbox's setup script", () => {
  it("is shown in the thread once, with its exit code and output", async () => {
    const log = join(temp(), "setup.log");
    writeFileSync(log, "exit 2\nnpm ERR! not found\n");
    const dataDir = temp();
    const make = () =>
      new ThreadRunner({
        thread: thread("setup-log-1"),
        workdir: temp(),
        dataDir,
        adapter: adapterFor("claude-code"),
        session: { autonomy: "full" },
        git: false,
        bundledSkills: false,
        setupLog: log,
      });
    const first = make();
    await first.init();
    const notice = first.store.since(0).find(e => e.type === "notice" && e.code.startsWith("setup_script"));
    expect(notice).toMatchObject({ code: "setup_script_failed", message: expect.stringMatching(/exit code 2[\s\S]*npm ERR! not found/) });
    await first.close();
    const second = make(); // the runner restarted: not shown again
    await second.init();
    expect(second.store.since(0).filter(e => e.type === "notice" && e.code.startsWith("setup_script"))).toHaveLength(1);
    await second.close();
  });
});

describe("skills", () => {
  it("can leave bundled skills out", async () => {
    const bundled = temp();
    for (const name of ["one", "two"]) {
      mkdirSync(join(bundled, name));
      writeFileSync(join(bundled, name, "SKILL.md"), `# ${name}`);
    }
    const workdir = temp();
    const installed = await installSkills({ workdir, kind: "claude-code", git: null, bundledDir: bundled, disabled: ["two"] });
    expect(installed).toEqual(["one"]);
    expect(existsSync(join(workdir, ".claude/skills/two"))).toBe(false);
  });

  it("write the workspace's skills from the environment and remove the variables", () => {
    const skills = [{ name: "deploy", files: { "SKILL.md": "# Deploy", "scripts/go.sh": "echo go" } }];
    const encoded = gzipSync(Buffer.from(JSON.stringify(skills))).toString("base64");
    const env: NodeJS.ProcessEnv = { LEMONLIME_USER_SKILLS_0: encoded.slice(0, 10), LEMONLIME_USER_SKILLS_1: encoded.slice(10) };
    const dir = temp();
    mkdirSync(join(dir, "deploy"));
    writeFileSync(join(dir, "deploy", "old.txt"), "stale");
    expect(writeUserSkills(dir, env)).toEqual(["deploy"]);
    expect(readFileSync(join(dir, "deploy", "scripts", "go.sh"), "utf8")).toBe("echo go");
    expect(existsSync(join(dir, "deploy", "old.txt"))).toBe(false);
    expect(Object.keys(env)).toEqual([]);
    const bad = gzipSync(Buffer.from(JSON.stringify([{ name: "x", files: { "SKILL.md": "x", "../escape": "x" } }]))).toString("base64");
    expect(() => writeUserSkills(dir, { LEMONLIME_USER_SKILLS_0: bad })).toThrow(/not valid/);
  });
});

describe("knowing a busy provider", () => {
  it("tells overloaded apart from other failures, and reads when to try again", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(classifyAgentFailure('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("overloaded");
    expect(classifyAgentFailure("stream error: 503 Service Unavailable")).toBe("overloaded");
    expect(classifyAgentFailure("Claude AI usage limit reached|1794081600")).toBe("usage_limit");
    expect(classifyAgentFailure("syntax error")).toBe("agent_failed");
    expect(retryAfterAt("Overloaded, retry after 30 seconds", now)).toBe("2026-11-07T12:00:30.000Z");
    expect(retryAfterAt("try again in 20 minutes", now)).toBeNull(); // minutes: limitResetAt reads those
    const err = turnFailure("Server overloaded, try again in 5 minutes") as AgentError;
    expect(err.code).toBe("overloaded");
    expect(err.resetAt).toBeTruthy();
  });

  it("writes Codex instructions as a TOML string", () => {
    expect(tomlString('a"b\\c\n\u0001\u007f')).toBe('"a\\"b\\\\c\\n\\u0001\\u007f"');
  });
});
