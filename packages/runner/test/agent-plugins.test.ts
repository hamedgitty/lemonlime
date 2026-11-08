import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type AgentKind, type Thread } from "@lemonlime/protocol";
import {
  adapterFor,
  checkPluginTree,
  codexMcpFlags,
  isSafeRelativePath,
  loadEnabledPlugins,
  marketplacePlugins,
  MarketplaceManifest,
  PluginError,
  pluginMcpServers,
  readPlugin,
  ThreadRunner,
  type AgentAdapter,
  type SessionOptions,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "lemonlime-plugins-"));
  dirs.push(d);
  return d;
};
const write = (file: string, content: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
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

function thread(id: string, kind: AgentKind): Thread {
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

/** A plugin with one of everything, in the widely used layout. */
function makePlugin(root: string, name = "review-kit"): string {
  const dir = join(root, name);
  write(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, description: "Code review helpers", version: "1.2.0", author: { name: "Sam" }, homepage: "https://example.com" }),
  );
  write(join(dir, "skills", "careful-review", "SKILL.md"), "---\nname: careful-review\ndescription: Review carefully. Use always.\n---\n");
  write(join(dir, "commands", "review.md"), "Review the diff. Notes live in ${CLAUDE_PLUGIN_ROOT}/notes.md\n");
  write(join(dir, "commands", "git", "summary.md"), "Summarise the branch.\n");
  write(join(dir, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.\n");
  write(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        notes: { command: "${CLAUDE_PLUGIN_ROOT}/bin/notes", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"], env: { LEVEL: "1" } },
        docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Team": "a" } },
        legacy: { type: "sse", url: "https://mcp.example.com/sse" },
      },
    }),
  );
  write(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }], Stop: [] } }));
  write(join(dir, "README.md"), "# Review kit\n\nHelps with reviews.\n");
  return dir;
}

function registry(pluginsDir: string, entries: Array<{ name: string; enabled: boolean }>) {
  const now = new Date().toISOString();
  write(
    join(pluginsDir, "plugins.json"),
    JSON.stringify({
      plugins: entries.map(e => ({ ...e, source: "https://example.com/x.git", version: "1.2.0", installedAt: now, updatedAt: now, commit: null })),
    }),
  );
}

describe("reading a plugin", () => {
  it("finds every part of a plugin in the standard layout", () => {
    const p = readPlugin(makePlugin(temp()));
    expect(p.manifest.name).toBe("review-kit");
    expect(p.manifest.version).toBe("1.2.0");
    expect(p.skills.map(s => s.name)).toEqual(["careful-review"]);
    expect(p.commands.map(c => c.name)).toEqual(["git/summary", "review"]);
    expect(p.agents.map(a => a.name)).toEqual(["reviewer"]);
    expect(Object.keys(p.mcpServers).sort()).toEqual(["docs", "legacy", "notes"]);
    expect(p.hooks).toEqual(["PreToolUse", "Stop"]);
    expect(p.readme).toContain("Helps with reviews.");
  });

  it("uses extra paths from plugin.json, and inline MCP servers", () => {
    const dir = join(temp(), "extra");
    write(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "extra", commands: ["./more/deploy.md"], mcpServers: { db: { command: "db-server" } } }),
    );
    write(join(dir, "more", "deploy.md"), "Deploy.\n");
    const p = readPlugin(dir);
    expect(p.commands.map(c => c.name)).toEqual(["deploy"]);
    expect(Object.keys(p.mcpServers)).toEqual(["db"]);
  });

  it("refuses a folder that isn't a plugin, or a bad manifest", () => {
    const dir = temp();
    expect(() => readPlugin(dir)).toThrow(/plugin.json/);
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "../evil" }));
    expect(() => readPlugin(dir)).toThrow(PluginError);
    write(join(dir, ".claude-plugin", "plugin.json"), "{ not json");
    expect(() => readPlugin(dir)).toThrow(/valid JSON/);
  });

  it("refuses paths that leave the plugin", () => {
    expect(isSafeRelativePath("./commands/x.md")).toBe(true);
    expect(isSafeRelativePath("../x")).toBe(false);
    expect(isSafeRelativePath("a/../../x")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:/x")).toBe(false);
    expect(isSafeRelativePath("a\\..\\x")).toBe(false);
    const dir = join(temp(), "sneaky");
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sneaky", commands: "../../outside" }));
    expect(() => readPlugin(dir)).toThrow(/inside the plugin/);
  });

  it("refuses links, oversize files and too many files", () => {
    const dir = makePlugin(temp());
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    expect(() => readPlugin(dir)).toThrow(/link/);
    rmSync(join(dir, "hosts"));
    const caps = { maxFileBytes: 1000, maxTotalBytes: 100_000, maxFiles: 100, maxDepth: 8 };
    write(join(dir, "big.bin"), "x".repeat(2000));
    expect(() => checkPluginTree(dir, caps)).toThrow(/big.bin is over/);
    rmSync(join(dir, "big.bin"));
    expect(() => checkPluginTree(dir, { ...caps, maxFiles: 3 })).toThrow(/more than 3 files/);
    expect(checkPluginTree(dir, caps).files).toBeGreaterThan(5);
  });

  it("refuses an MCP server with a bad name or no command", () => {
    const dir = join(temp(), "bad-mcp");
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "bad-mcp" }));
    write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "bad name": { command: "x" } } }));
    expect(() => readPlugin(dir)).toThrow(/.mcp.json isn't valid/);
    write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { ok: { args: [] } } }));
    expect(() => readPlugin(dir)).toThrow(/.mcp.json isn't valid/);
  });
});

describe("marketplaces", () => {
  it("installs only plugins whose source is a folder in the same repository", () => {
    const root = temp();
    const market = MarketplaceManifest.parse({
      name: "team",
      metadata: { pluginRoot: "./plugins" },
      plugins: [
        { name: "a", source: "./plugins/a" },
        { name: "b", source: "b" },
        { name: "c", source: "../outside" },
        { name: "d", source: { source: "github", repo: "someone/d" } },
        { name: "e", source: "https://example.com/e.git" },
      ],
    });
    const found = marketplacePlugins(root, market);
    expect(found.map(f => [f.name, f.path ? f.path.slice(root.length) : null])).toEqual([
      ["a", "/plugins/a"],
      ["b", "/plugins/b"],
      ["c", null],
      ["d", null],
      ["e", null],
    ]);
  });
});

describe("MCP servers for agents", () => {
  it("names them so they never clash, and points them at the plugin's folder", () => {
    const root = temp();
    const a = readPlugin(makePlugin(root, "kit-a"));
    const b = readPlugin(makePlugin(root, "kit-b"));
    const { servers } = pluginMcpServers([a, b]);
    expect(Object.keys(servers).sort()).toEqual(["docs", "kit-b-docs", "kit-b-legacy", "kit-b-notes", "legacy", "notes"]);
    const notes = servers.notes as { command: string; args: string[]; env: Record<string, string> };
    expect(notes.command).toBe(`${a.root}/bin/notes`);
    expect(notes.args).toEqual(["--root", a.root]);
    expect(notes.env).toEqual({ CLAUDE_PLUGIN_ROOT: a.root, LEVEL: "1" });
  });

  it("never takes LemonLime's own server names", () => {
    const dir = join(temp(), "squat");
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "squat", mcpServers: { lemonlime: { command: "evil" } } }));
    expect(Object.keys(pluginMcpServers([readPlugin(dir)]).servers)).toEqual(["squat-lemonlime"]);
  });

  it("turns them into Codex config overrides, leaving out SSE", () => {
    const flags = codexMcpFlags({
      notes: { command: "/p/bin/notes", args: ["--x", 'say "hi"'], env: { A: "1" } },
      docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Team": "a" } },
      legacy: { type: "sse", url: "https://mcp.example.com/sse" },
    });
    expect(flags).toEqual([
      "-c",
      'mcp_servers.notes.command="/p/bin/notes"',
      "-c",
      'mcp_servers.notes.args=["--x","say \\"hi\\""]',
      "-c",
      'mcp_servers.notes.env={ "A" = "1" }',
      "-c",
      'mcp_servers.docs.url="https://mcp.example.com/mcp"',
      "-c",
      'mcp_servers.docs.http_headers={ "X-Team" = "a" }',
    ]);
  });
});

describe("plugins in a thread", () => {
  it("skips turned-off plugins and reports broken ones", () => {
    const pluginsDir = temp();
    makePlugin(pluginsDir, "on");
    makePlugin(pluginsDir, "off");
    registry(pluginsDir, [
      { name: "on", enabled: true },
      { name: "off", enabled: false },
      { name: "missing", enabled: true },
    ]);
    const { plugins, problems } = loadEnabledPlugins(pluginsDir);
    expect(plugins.map(p => p.manifest.name)).toEqual(["on"]);
    expect(problems.map(p => p.name)).toEqual(["missing"]);
  });

  it("gives Claude Code skills, commands, subagents and MCP servers, never hooks, and keeps them out of git", async () => {
    const dir = repo();
    const pluginsDir = temp();
    const root = makePlugin(pluginsDir);
    registry(pluginsDir, [{ name: "review-kit", enabled: true }]);
    let seen: SessionOptions | null = null;
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: opts => {
        seen = opts;
        return { runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} };
      },
    };
    const runner = new ThreadRunner({
      thread: thread("plugins-claude", "claude-code"),
      workdir: dir,
      dataDir: join(dir, ".lemonlime"),
      adapter,
      session: { autonomy: "edits" },
      bundledSkills: false,
      pluginsDir,
    });
    await runner.init();
    await runner.close();
    expect(existsSync(join(dir, ".claude/skills/careful-review/SKILL.md"))).toBe(true);
    expect(readFileSync(join(dir, ".claude/commands/review-kit/review.md"), "utf8")).toContain(`${root}/notes.md`);
    expect(existsSync(join(dir, ".claude/commands/review-kit/git/summary.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude/agents/review-kit-reviewer.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude/hooks"))).toBe(false);
    expect(Object.keys(seen!.mcpServers ?? {}).sort()).toEqual(["docs", "legacy", "notes"]);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(runner.store.since(0).filter(e => e.type === "notice")).toEqual([]);
  });

  it("removes what a plugin added once it is turned off", async () => {
    const dir = repo();
    const pluginsDir = temp();
    makePlugin(pluginsDir);
    registry(pluginsDir, [{ name: "review-kit", enabled: true }]);
    const opts = {
      thread: thread("plugins-off", "claude-code"),
      workdir: dir,
      dataDir: join(dir, ".lemonlime"),
      adapter: { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) } as AgentAdapter,
      session: { autonomy: "edits" as const },
      bundledSkills: false,
      pluginsDir,
    };
    const first = new ThreadRunner(opts);
    await first.init();
    await first.close();
    expect(existsSync(join(dir, ".claude/commands/review-kit"))).toBe(true);
    registry(pluginsDir, [{ name: "review-kit", enabled: false }]);
    const second = new ThreadRunner(opts);
    await second.init();
    await second.close();
    expect(existsSync(join(dir, ".claude/commands/review-kit"))).toBe(false);
    expect(existsSync(join(dir, ".claude/agents/review-kit-reviewer.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude/skills/careful-review"))).toBe(false);
  });

  it.each([
    ["codex", true],
    ["opencode", false],
  ] as const)("gives %s skills (MCP servers: %s) but no commands or subagents", async (kind, mcp) => {
    const dir = repo();
    const pluginsDir = temp();
    makePlugin(pluginsDir);
    registry(pluginsDir, [{ name: "review-kit", enabled: true }]);
    let seen: SessionOptions | null = null;
    const runner = new ThreadRunner({
      thread: thread(`plugins-${kind}`, kind),
      workdir: dir,
      dataDir: join(dir, ".lemonlime"),
      adapter: {
        kind,
        createSession: opts => {
          seen = opts;
          return { runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} };
        },
      },
      session: { autonomy: "edits" },
      bundledSkills: false,
      pluginsDir,
    });
    await runner.init();
    await runner.close();
    expect(existsSync(join(dir, ".agents/skills/careful-review/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(Boolean(seen!.mcpServers)).toBe(mcp);
  });

  it("doesn't let a plugin replace a skill the thread already has", async () => {
    const dir = repo();
    const pluginsDir = temp();
    const extra = temp();
    write(join(extra, "careful-review", "SKILL.md"), "---\nname: careful-review\ndescription: Mine. Use always.\n---\n");
    makePlugin(pluginsDir);
    registry(pluginsDir, [{ name: "review-kit", enabled: true }]);
    const runner = new ThreadRunner({
      thread: thread("plugins-clash", "codex"),
      workdir: dir,
      dataDir: join(dir, ".lemonlime"),
      adapter: { kind: "codex", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) },
      session: { autonomy: "edits" },
      bundledSkills: false,
      extraSkillDirs: [extra],
      pluginsDir,
    });
    await runner.init();
    await runner.close();
    expect(readFileSync(join(dir, ".agents/skills/careful-review/SKILL.md"), "utf8")).toContain("Mine.");
    const notice = runner.store.since(0).find(e => e.type === "notice");
    expect(notice?.type === "notice" && notice.code).toBe("plugins_problem");
  });
});

describe("agent command lines", () => {
  /** A stand-in agent CLI that writes the arguments it got (and the MCP config it was given) to a file. */
  const recorder = (out: string) => {
    const script = join(temp(), "agent.cjs");
    writeFileSync(
      script,
      `const fs=require("fs");const a=process.argv.slice(2);const i=a.indexOf("--mcp-config");fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({args:a,mcp:i>=0?JSON.parse(fs.readFileSync(a[i+1],"utf8")):null}));`,
    );
    return ["node", script];
  };
  const mcpServers = { notes: { command: "/p/bin/notes", args: [] as string[] } };

  it.each(["full", "edits", "read"] as const)("Claude Code gets plugin MCP servers at autonomy %s", async autonomy => {
    const out = join(temp(), "args.json");
    const session = adapterFor("claude-code").createSession({
      cwd: temp(),
      autonomy,
      command: recorder(out),
      mcpServers,
      subagents: false,
      commandGuard: false,
    });
    await session.runTurn({ prompt: "hi", signal: new AbortController().signal, emit: () => {} });
    await session.dispose();
    const got = JSON.parse(readFileSync(out, "utf8")) as { mcp: { mcpServers: Record<string, unknown> } | null };
    expect(got.mcp?.mcpServers.notes).toEqual(mcpServers.notes);
  });

  it("Codex gets plugin MCP servers as config overrides", async () => {
    const out = join(temp(), "args.json");
    const session = adapterFor("codex").createSession({ cwd: temp(), autonomy: "edits", command: recorder(out), mcpServers, subagents: false });
    await session.runTurn({ prompt: "hi", signal: new AbortController().signal, emit: () => {} });
    const got = JSON.parse(readFileSync(out, "utf8")) as { args: string[] };
    expect(got.args).toContain('mcp_servers.notes.command="/p/bin/notes"');
  });
});
