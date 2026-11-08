import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, HistoryImportResult, HistoryScan, ThreadEvent, type Thread } from "@lemonlime/protocol";
import { EventStore, historyCommand, importHistory, parseHistoryId, scanHistory, ThreadRunner, type AgentAdapter, type HistoryRoots } from "../src/index.ts";
import { cleanUserText, isInjected, readLines } from "../src/history/index.ts";
import { listOpenCodeSessions, readOpenCodeSession } from "../src/history/opencode.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "history");
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const CLAUDE_REPO = "claude-code:5b1c2d3e-0000-4000-8000-000000000001";
const CLAUDE_PLAIN = "claude-code:5b1c2d3e-0000-4000-8000-000000000002";
const CODEX = "codex:0aa1b2c3-0000-7000-8000-000000000003";
const OPENCODE = "opencode:ses_fixture01";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir })
    .toString()
    .trim();

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? files(join(dir, d.name)) : d.isFile() ? [join(dir, d.name)] : []));
}

/** Every file's content hash and modification time, to show the originals were left alone. */
function fingerprint(dir: string): Record<string, string> {
  return Object.fromEntries(files(dir).map(f => [f, `${createHash("sha256").update(readFileSync(f)).digest("hex")}:${statSync(f).mtimeMs}`]));
}

const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The fixture histories, copied somewhere writable with their folders pointed at a real repo. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "lemonlime-history-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const plain = join(root, "plain");
  mkdirSync(plain);
  const home = join(root, "home");
  cpSync(FIXTURES, home, { recursive: true });
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  for (const f of files(home)) {
    const text = readFileSync(f, "utf8");
    writeFileSync(f, text.replaceAll("__REPO__", esc(repo)).replaceAll("__PLAIN__", esc(plain)));
  }
  const roots: HistoryRoots = { "claude-code": join(home, "claude"), codex: join(home, "codex"), opencode: join(home, "opencode") };
  return { root, repo, plain, home, roots, lemonlimeHome: join(root, "lemonlime") };
}

describe("history scan", () => {
  it("summarises Claude Code, Codex and OpenCode conversations", async () => {
    const s = setup();
    const scan = HistoryScan.parse(await scanHistory({ sinceDays: 30, roots: s.roots, lemonlimeHome: s.lemonlimeHome, now: NOW }));
    const claude = scan.agents["claude-code"];
    expect(claude).toMatchObject({ found: true, sessions: 2, inRange: 2 });
    expect(claude.folders.map(f => f.path).sort()).toEqual([s.plain, s.repo].sort());
    // The repo conversation was active on two days.
    expect(claude.perDay[localDate("2026-10-20T09:00:00.000Z")]).toBe(1);
    expect(claude.perDay[localDate("2026-10-22T14:00:00.000Z")]).toBe(1);
    expect(scan.agents.codex).toMatchObject({ found: true, sessions: 1, inRange: 1, folders: [{ path: s.repo, sessions: 1 }] });
    // The subagent's child conversation isn't counted.
    expect(scan.agents.opencode).toMatchObject({ found: true, sessions: 1, inRange: 1 });

    const byId = Object.fromEntries(scan.sessions.map(x => [x.id, x]));
    expect(byId[CLAUDE_REPO]).toMatchObject({
      agent: "claude-code",
      title: "Login test fixes",
      cwd: s.repo,
      startedAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-22T14:00:30.000Z",
      messageCount: 6,
      partial: false,
    });
    expect(byId[CLAUDE_PLAIN]).toMatchObject({ title: "Tidy up my notes folder.", messageCount: 2 });
    expect(byId[CODEX]).toMatchObject({ title: "Health check endpoint", cwd: s.repo, messageCount: 2, startedAt: "2026-10-21T10:00:02.000Z" });
    expect(byId[OPENCODE]).toMatchObject({ title: "Why is the build so slow?", cwd: s.repo, startedAt: "2026-10-25T07:00:00.000Z" });
    // Newest first.
    expect(scan.sessions.map(x => x.id)).toEqual([CLAUDE_PLAIN, OPENCODE, CLAUDE_REPO, CODEX]);
  });

  it("keeps day counts for the year but lists only what's in range", async () => {
    const s = setup();
    const scan = await scanHistory({ sinceDays: 3, roots: s.roots, lemonlimeHome: s.lemonlimeHome, now: NOW });
    expect(scan.agents["claude-code"]).toMatchObject({ sessions: 2, inRange: 0, folders: [] });
    expect(Object.keys(scan.agents["claude-code"].perDay).length).toBe(3);
    expect(scan.sessions).toEqual([]);
    const limited = await scanHistory({ sinceDays: 30, limit: 1, roots: s.roots, lemonlimeHome: s.lemonlimeHome, now: NOW });
    expect(limited.sessions.length).toBe(1);
    expect(limited.agents["claude-code"].inRange).toBe(2);
  });

  it("says plainly when an agent's history isn't there", async () => {
    const s = setup();
    const missing = join(s.root, "nothing");
    const scan = await scanHistory({
      sinceDays: 30,
      roots: { "claude-code": missing, codex: missing, opencode: missing },
      lemonlimeHome: s.lemonlimeHome,
      now: NOW,
    });
    for (const a of Object.values(scan.agents)) {
      expect(a).toMatchObject({ found: false, sessions: 0, inRange: 0, perDay: {}, folders: [] });
      expect(a.note).toMatch(/No .* history on this computer/);
    }
  });

  it("never follows symbolic links out of an agent's folder", async () => {
    const s = setup();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    const session = readFileSync(join(s.roots["claude-code"], "projects", "-REPO", "5b1c2d3e-0000-4000-8000-000000000001.jsonl"));
    writeFileSync(join(outside, "5b1c2d3e-0000-4000-8000-00000000000a.jsonl"), session);
    symlinkSync(outside, join(s.roots["claude-code"], "projects", "-linked"));
    symlinkSync(
      join(outside, "5b1c2d3e-0000-4000-8000-00000000000a.jsonl"),
      join(s.roots["claude-code"], "projects", "-REPO", "5b1c2d3e-0000-4000-8000-00000000000b.jsonl"),
    );
    const scan = await scanHistory({ sinceDays: 30, roots: s.roots, lemonlimeHome: s.lemonlimeHome, now: NOW });
    expect(scan.agents["claude-code"].sessions).toBe(2);
    const r = await importHistory({ ids: ["claude-code:5b1c2d3e-0000-4000-8000-00000000000b"], roots: s.roots, lemonlimeHome: s.lemonlimeHome });
    expect(r.imported).toEqual([]);
  });

  it("leaves out conversations LemonLime itself ran", async () => {
    const s = setup();
    const own = join(s.lemonlimeHome, "worktrees", "repo-1234", "thread-1");
    mkdirSync(join(s.roots["claude-code"], "projects", "-own"), { recursive: true });
    writeFileSync(
      join(s.roots["claude-code"], "projects", "-own", "5b1c2d3e-0000-4000-8000-0000000000ff.jsonl"),
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-10-30T10:00:00.000Z", cwd: own }) + "\n",
    );
    const scan = await scanHistory({ sinceDays: 30, roots: s.roots, lemonlimeHome: s.lemonlimeHome, now: NOW });
    expect(scan.agents["claude-code"].sessions).toBe(2);
    expect(scan.sessions.some(x => x.sessionId.endsWith("ff"))).toBe(false);
  });
});

describe("reading history files", () => {
  it("skips lines that are too long without holding them, and partial lines at a range's start", () => {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-lines-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = join(dir, "x.jsonl");
    writeFileSync(f, `short\n${"x".repeat(5000)}\nafter\nlast-no-newline`);
    expect([...readLines(f, { maxLine: 100 })]).toEqual(["short", "after", "last-no-newline"]);
    expect([...readLines(f, { start: 2, maxLine: 100 })]).toEqual(["after", "last-no-newline"]);
    expect([...readLines(f, { start: 6, maxLine: 100_000 })].map(l => l.length)).toEqual([5000, 5, 15]);
    expect([...readLines(join(dir, "missing"))]).toEqual([]);
  });

  it("keeps what the user typed from Claude Code's wrappers", () => {
    expect(cleanUserText("<command-name>/model</command-name><command-args>opus</command-args>")).toBe("/model opus");
    expect(cleanUserText("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
    expect(cleanUserText("<bash-input>ls -la</bash-input>")).toBe("! ls -la");
    expect(cleanUserText("Fix it<system-reminder>noise</system-reminder>")).toBe("Fix it");
    expect(cleanUserText("[Request interrupted by user]")).toBeNull();
  });

  it("tells Codex's own context apart from the user's messages", () => {
    expect(isInjected("<environment_context>\n<cwd>/x</cwd>")).toBe(true);
    expect(isInjected("# AGENTS.md instructions for /x")).toBe(true);
    expect(isInjected("Add a test for the parser")).toBe(false);
  });

  it("parses ids", () => {
    expect(parseHistoryId(CODEX)).toEqual({ agent: "codex", sessionId: "0aa1b2c3-0000-7000-8000-000000000003" });
    expect(parseHistoryId("acp:x")).toBeNull();
    expect(parseHistoryId("codex:../../etc")).toBeNull();
    expect(parseHistoryId("nothing")).toBeNull();
  });
});

describe("history import", () => {
  it("makes local threads with the conversation as LemonLime events, and leaves the originals alone", async () => {
    const s = setup();
    const before = fingerprint(s.home);
    const r = HistoryImportResult.parse(
      await importHistory({
        ids: [CLAUDE_REPO, CODEX, OPENCODE, CLAUDE_PLAIN, "claude-code:5b1c2d3e-0000-4000-8000-00000000dead", "bogus"],
        roots: s.roots,
        lemonlimeHome: s.lemonlimeHome,
      }),
    );
    expect(fingerprint(s.home)).toEqual(before);

    expect(r.imported.map(i => i.id)).toEqual([CLAUDE_REPO, CODEX, OPENCODE]);
    const skipped = Object.fromEntries(r.skipped.map(x => [x.id, x.reason]));
    expect(skipped[CLAUDE_PLAIN]).toMatch(/isn't a git repository/);
    expect(skipped["claude-code:5b1c2d3e-0000-4000-8000-00000000dead"]).toMatch(/Couldn't find/);
    expect(skipped.bogus).toMatch(/isn't a conversation id/);

    const claude = r.imported[0]!;
    expect(claude.already).toBe(false);
    expect(claude.thread).toMatchObject({
      title: "Login test fixes",
      agent: { kind: "claude-code" },
      repoPath: realpathSync(s.repo),
      baseBranch: "main",
      branch: branchForThread(claude.thread.id),
      status: "idle",
      lastSeq: 0,
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-22T14:00:30.000Z",
    });
    expect(r.imported.map(i => i.thread.agent.kind)).toEqual(["claude-code", "codex", "opencode"]);

    // The history is where the thread's runner keeps it, and loads as valid events.
    const dir = join(s.lemonlimeHome, "threads", claude.thread.id);
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
    const events = lines.map(l => ThreadEvent.parse(JSON.parse(l)));
    expect(new EventStore(claude.thread.id, join(dir, "events.jsonl")).latestSeq).toBe(lines.length);
    expect(events[0]).toMatchObject({ type: "notice", code: "imported", at: "2026-10-20T09:00:00.000Z" });
    expect(events[0]!.type === "notice" && events[0]!.message).toMatch(/^Imported from Claude Code, where this conversation started on/);
    expect(events.at(-1)).toMatchObject({ type: "notice", code: "imported_ready" });
    const conversation = events.slice(1, -1).map(e => {
      if (e.type === "user_message") return `user: ${e.text}`;
      if (e.type === "agent_message") return `agent: ${e.text}`;
      if (e.type === "tool_call") return `call ${e.callId} ${e.name} ${JSON.stringify(e.input)}`;
      if (e.type === "tool_result") return `result ${e.callId}`;
      return e.type;
    });
    expect(conversation).toEqual([
      "user: The login test fails about one run in five. Find out why and fix it.",
      "agent: I'll look at the test first.",
      'call toolu_1 Read {"file_path":"test/login.test.ts"}',
      "result toolu_1",
      "agent: The test doesn't wait for the session cookie. I made it await the login response.",
      "user: /compact",
      "user: Now also note the fix in the changelog.",
      "agent: Added a line to CHANGELOG.md.",
    ]);
    expect(events.find(e => e.type === "user_message")!.at).toBe("2026-10-20T09:00:00.000Z");
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { recap: string; status: string };
    expect(state.status).toBe("idle");
    expect(state.recap).toContain("This conversation started in Claude Code");
    expect(state.recap).toContain("User: The login test fails");
    expect(state.recap).toContain("You: Added a line to CHANGELOG.md.");

    const codexEvents = readFileSync(join(s.lemonlimeHome, "threads", r.imported[1]!.thread.id, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(l => ThreadEvent.parse(JSON.parse(l)));
    expect(codexEvents.filter(e => e.type === "user_message").map(e => (e as { text: string }).text)).toEqual(["Add a health check endpoint at /health."]);
    expect(codexEvents.filter(e => e.type === "tool_call").map(e => [(e as { name: string }).name, (e as { input: unknown }).input])).toEqual([
      ["shell", { command: ["ls", "src"] }],
      ["apply_patch", expect.stringContaining("*** Begin Patch")],
    ]);
    expect(codexEvents.filter(e => e.type === "tool_result").length).toBe(2);
    expect(codexEvents.filter(e => e.type === "agent_message").map(e => (e as { text: string }).text)).toEqual(["Added GET /health, which answers 200."]);

    const openEvents = readFileSync(join(s.lemonlimeHome, "threads", r.imported[2]!.thread.id, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(l => ThreadEvent.parse(JSON.parse(l)));
    expect(openEvents.map(e => e.type)).toEqual(["notice", "user_message", "tool_call", "tool_result", "agent_message", "notice"]);
    expect(openEvents[1]).toMatchObject({ text: "Why is the build so slow?" });
    expect(openEvents[2]).toMatchObject({ name: "bash", callId: "call_b1", input: { command: "npm run build" } });
    expect(openEvents[3]).toMatchObject({ output: "built in 40s", isError: false });
  });

  it("returns the same thread when a conversation is imported again, and shows it in scans", async () => {
    const s = setup();
    const first = await importHistory({ ids: [CLAUDE_REPO], roots: s.roots, lemonlimeHome: s.lemonlimeHome });
    const id = first.imported[0]!.thread.id;
    const file = join(s.lemonlimeHome, "threads", id, "events.jsonl");
    const size = statSync(file).size;
    const again = await importHistory({ ids: [CLAUDE_REPO, CLAUDE_REPO], roots: s.roots, lemonlimeHome: s.lemonlimeHome });
    expect(again.imported).toEqual([{ id: CLAUDE_REPO, thread: first.imported[0]!.thread, already: true }]);
    expect(statSync(file).size).toBe(size);
    expect(readdirSync(join(s.lemonlimeHome, "threads"))).toEqual([id]);
    const scan = await scanHistory({ sinceDays: 30, roots: s.roots, lemonlimeHome: s.lemonlimeHome, now: NOW });
    expect(scan.sessions.find(x => x.id === CLAUDE_REPO)?.importedThreadId).toBe(id);

    // Once the thread is deleted, importing makes a new one.
    rmSync(join(s.lemonlimeHome, "threads", id), { recursive: true });
    const fresh = await importHistory({ ids: [CLAUDE_REPO], roots: s.roots, lemonlimeHome: s.lemonlimeHome });
    expect(fresh.imported[0]!.already).toBe(false);
    expect(fresh.imported[0]!.thread.id).not.toBe(id);
  });

  it("gives the agent a recap with the first new message in an imported thread", async () => {
    const s = setup();
    const r = await importHistory({ ids: [CLAUDE_REPO], roots: s.roots, lemonlimeHome: s.lemonlimeHome });
    const meta = r.imported[0]!.thread;
    const prompts: string[] = [];
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: async ctx => {
          prompts.push(ctx.prompt);
          ctx.emit({ type: "agent_message", text: "On it." });
        },
        saveState: () => ({ sessionId: "fresh" }),
        dispose: async () => undefined,
      }),
    };
    const now = new Date().toISOString();
    const thread: Thread = {
      id: meta.id,
      title: meta.title,
      agent: meta.agent,
      repo: { url: meta.repoPath, baseBranch: meta.baseBranch },
      branch: meta.branch,
      mode: "local",
      status: "idle",
      sandboxSize: "small",
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    const runner = new ThreadRunner({
      thread,
      workdir: join(s.root, "worktree"),
      dataDir: join(s.lemonlimeHome, "threads", meta.id),
      adapter,
      session: { autonomy: "full" },
      sourceRepo: meta.repoPath,
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    // The imported history is what the timeline shows first.
    expect(runner.store.since(0)[0]).toMatchObject({ type: "notice", code: "imported" });
    runner.sendMessage("Carry on with the docs.");
    await runner.settled();
    runner.sendMessage("Thanks.");
    await runner.settled();
    expect(prompts[0]).toContain("This conversation started in Claude Code");
    expect(prompts[0]).toContain("User: The login test fails about one run in five.");
    expect(prompts[0]!.endsWith("Carry on with the docs.")).toBe(true);
    expect(prompts[1]).toBe("Thanks.");
    const state = JSON.parse(readFileSync(join(s.lemonlimeHome, "threads", meta.id, "state.json"), "utf8")) as { recap?: string };
    expect(state.recap).toBeUndefined();
  });
});

describe("OpenCode's database", () => {
  it("reads conversations from opencode.db without changing it", async () => {
    let DatabaseSync:
      | (new (path: string, o?: { readOnly?: boolean }) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown }; close(): void })
      | undefined;
    try {
      ({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: typeof DatabaseSync });
    } catch {
      return; // this Node has no SQLite; the reader then says so instead
    }
    const s = setup();
    const root = join(s.root, "opencode-db");
    mkdirSync(root);
    const db = new DatabaseSync!(join(root, "opencode.db"));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    const t = Date.parse("2026-10-28T10:00:00.000Z");
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("ses_db1", "p1", null, s.repo, "Speed up the build", t, t + 60_000);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("ses_db2", "p1", "ses_db1", s.repo, "Child", t, t);
    const msg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    msg.run("msg_a", "ses_db1", t, t, JSON.stringify({ role: "user", time: { created: t } }));
    msg.run("msg_b", "ses_db1", t + 1000, t + 1000, JSON.stringify({ role: "assistant", time: { created: t + 1000 } }));
    msg.run("msg_c", "ses_db1", t + 2000, t + 2000, JSON.stringify({ role: "assistant", time: { created: t + 2000 } }));
    const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    part.run("prt_a", "msg_a", "ses_db1", t, t, JSON.stringify({ type: "text", text: "Make the build faster" }));
    part.run(
      "prt_b",
      "msg_b",
      "ses_db1",
      t + 1000,
      t + 1000,
      JSON.stringify({ type: "tool", tool: "read", callID: "c1", state: { status: "error", input: { path: "x" }, error: "no such file" } }),
    );
    part.run("prt_c", "msg_c", "ses_db1", t + 2000, t + 2000, JSON.stringify({ type: "text", text: "Turned on caching." }));
    db.close();
    const before = fingerprint(root);

    const listing = await listOpenCodeSessions(root, 0);
    expect(listing).toMatchObject({ found: true, total: 1 });
    expect(listing.sessions[0]).toMatchObject({
      sessionId: "ses_db1",
      title: "Speed up the build",
      cwd: s.repo,
      messageCount: 2,
      startedAt: "2026-10-28T10:00:00.000Z",
    });
    const transcript = await readOpenCodeSession(root, "ses_db1");
    expect(transcript!.events.map(e => e.event.type)).toEqual(["user_message", "tool_call", "tool_result", "agent_message"]);
    expect(transcript!.events[2]!.event).toMatchObject({ isError: true, output: "no such file" });
    expect(fingerprint(root)).toEqual(before);
  });
});

describe("lemonlime-runner history", () => {
  it("prints a scan and an import as JSON", async () => {
    const s = setup();
    const saved = { ...process.env };
    cleanups.push(() => {
      process.env = saved;
    });
    process.env.LEMONLIME_HOME = s.lemonlimeHome;
    process.env.CLAUDE_CONFIG_DIR = s.roots["claude-code"];
    process.env.CODEX_HOME = s.roots.codex;
    process.env.XDG_DATA_HOME = s.home;
    let out = "";
    await historyCommand(["scan", "--since-days", "3650"], t => (out += t));
    const scan = HistoryScan.parse(JSON.parse(out));
    expect(scan.sessions.map(x => x.id).sort()).toEqual([CLAUDE_PLAIN, CLAUDE_REPO, CODEX, OPENCODE].sort());
    out = "";
    await historyCommand(["import", CODEX], t => (out += t));
    expect(HistoryImportResult.parse(JSON.parse(out)).imported[0]!.thread.agent.kind).toBe("codex");
    await expect(historyCommand(["scan", "--since-days", "0"], () => undefined)).rejects.toThrow(/--since-days/);
    await expect(historyCommand(["import"], () => undefined)).rejects.toThrow(/usage/);
  });
});
