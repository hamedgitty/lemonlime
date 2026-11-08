import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";
import { parseClaudeLine } from "../src/agents/claude-code.ts";
import { commandFiles, commandsFromAcp, commandsFromNames, listCommands, listWorkdirFiles, readFront, searchFiles } from "../src/composer.ts";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-composer-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir: string, path: string, text = "x\n") {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function repo(): string {
  const dir = tempDir();
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  g("init", "-q", "-b", "main");
  write(dir, "README.md");
  write(dir, "src/components/Button.tsx");
  write(dir, "src/but/test.ts");
  write(dir, ".gitignore", "secret.env\nbuild/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  write(dir, "notes/new-idea.md");
  write(dir, "secret.env");
  write(dir, "build/out.js");
  return dir;
}

describe("listing files for the composer", () => {
  it("lists tracked and new files, leaving out ignored ones", async () => {
    const dir = repo();
    const files = await listWorkdirFiles(dir);
    expect(files.sort()).toEqual([".gitignore", "README.md", "notes/new-idea.md", "src/but/test.ts", "src/components/Button.tsx"]);
  });

  it("walks the folder when it isn't a git repository", async () => {
    const dir = tempDir();
    write(dir, "a.txt");
    write(dir, "lib/b.ts");
    write(dir, "node_modules/pkg/index.js");
    expect((await listWorkdirFiles(dir)).sort()).toEqual(["a.txt", "lib/b.ts"]);
  });

  it("puts the best fuzzy matches first and caps the answer", () => {
    const files = ["src/but/test.ts", "src/components/Button.tsx", "README.md", "docs/a.md", "docs/b.md"];
    expect(searchFiles(files, "butt", 10).files[0]).toBe("src/components/Button.tsx");
    const none = searchFiles(files, "", 2);
    expect(none.files).toEqual(["README.md", "docs/a.md"]);
    expect(none.truncated).toBe(true);
    expect(none.total).toBe(5);
    expect(searchFiles(files, "zzz", 10).files).toEqual([]);
  });
});

describe("slash commands", () => {
  it("reads command files, including ones in folders, with their descriptions", () => {
    const dir = tempDir();
    write(dir, "review.md", "---\ndescription: Review the diff\nargument-hint: <branch>\n---\nLook at it.\n");
    write(dir, "frontend/component.md", "# Make a component\n\nBody");
    const found = commandFiles(dir, "project").sort((a, b) => a.name.localeCompare(b.name));
    expect(found).toEqual([
      { name: "frontend:component", description: "Make a component", source: "project" },
      { name: "review", description: "Review the diff", hint: "<branch>", source: "project" },
    ]);
    expect(readFront(join(dir, "missing.md"))).toEqual({ description: "" });
  });

  it("merges what the agent reported with files and skills in the thread", () => {
    const dir = tempDir();
    const home = tempDir();
    write(dir, ".claude/commands/review.md", "---\ndescription: Review the diff\n---\n");
    write(dir, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship it\n---\n");
    write(home, ".claude/commands/mine.md", "My own command");
    const list = listCommands({ kind: "claude-code", workdir: dir, home, reported: commandsFromNames(["compact", "review"]) });
    expect(list.map(c => [c.name, c.source, c.description])).toEqual([
      ["compact", "agent", ""],
      ["deploy", "skill", "Ship it"],
      ["mine", "user", "My own command"],
      ["review", "agent", "Review the diff"],
    ]);
    // Other agents don't read Claude's folders.
    expect(listCommands({ kind: "codex", workdir: dir, home, reported: [] })).toEqual([]);
  });

  it("parses the commands agents report", () => {
    expect(commandsFromAcp([{ name: "plan", description: "Make a plan", input: { hint: "what to plan" } }, { bad: true }, { name: "" }])).toEqual([
      { name: "plan", description: "Make a plan", hint: "what to plan", source: "agent" },
    ]);
    expect(commandsFromAcp("nope")).toEqual([]);
    const init = parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", slash_commands: ["compact", "/review", 3] }));
    expect(init.sessionId).toBe("s1");
    expect(init.commands?.map(c => c.name)).toEqual(["compact", "review"]);
  });
});

describe("runner endpoints", () => {
  it("serves files and commands to clients with a token", async () => {
    const dir = repo();
    write(dir, ".claude/commands/review.md", "---\ndescription: Review the diff\n---\n");
    const now = new Date().toISOString();
    const thread: Thread = {
      id: "composer-thread",
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "local", baseBranch: "main" },
      branch: branchForThread("composer-thread"),
      mode: "local",
      status: "provisioning",
      sandboxSize: "small",
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async () => {},
        saveState: () => ({}),
        dispose: async () => {},
        commands: () => commandsFromNames(["compact"]),
      }),
    };
    const runner = new ThreadRunner({ thread, workdir: dir, dataDir: join(dir, ".lemonlime"), adapter, session: { autonomy: "edits" } });
    await runner.init();
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "test" });
    cleanups.push(async () => {
      await runner.close();
      await server.close();
    });
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { authorization: `Bearer ${await signToken({ threadId: thread.id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET)}` };

    expect((await fetch(`${base}/files?q=butt`)).status).toBe(401);
    const files = (await (await fetch(`${base}/files?q=butt&limit=1`, { headers: auth })).json()) as { files: string[]; truncated: boolean };
    expect(files.files).toEqual(["src/components/Button.tsx"]);
    expect(files.truncated).toBe(true);

    const commands = (await (await fetch(`${base}/commands`, { headers: auth })).json()) as { commands: { name: string }[] };
    expect(commands.commands.map(c => c.name)).toEqual(expect.arrayContaining(["compact", "review"]));
  });
});
