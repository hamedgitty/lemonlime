import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { teleportThread } from "@lemonlime/client";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";
import { importThread } from "../src/teleport.ts";
import { createHash, randomUUID } from "node:crypto";

const SECRET = "thread-secret-for-tests-0123456789";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir })
    .toString()
    .trim();

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
    createdAt: now,
    updatedAt: now,
  };
}

async function runnerFor(id: string, source: string, prompts: string[]) {
  const adapter: AgentAdapter = {
    kind: "claude-code",
    createSession: opts => ({
      runTurn: async ctx => {
        prompts.push(ctx.prompt);
        writeFileSync(join(opts.cwd, "notes.md"), `${readFileSync(join(opts.cwd, "notes.md"), "utf8")}${ctx.prompt.split("\n").at(-1)}\n`);
        ctx.emit({ type: "agent_message", text: `Noted: ${ctx.prompt.split("\n").at(-1)}` });
      },
      saveState: () => ({}),
      dispose: async () => {},
    }),
  };
  const work = join(mkdtempSync(join(tmpdir(), "lemonlime-tp-")), "w");
  const runner = new ThreadRunner({
    thread: thread(id),
    workdir: work,
    dataDir: join(work, "..", "data"),
    adapter,
    session: { autonomy: "full" },
    sourceRepo: source,
    bundledSkills: false,
  });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  const address = {
    url: `ws://127.0.0.1:${server.port}/ws`,
    token: () => signToken({ threadId: id, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET),
  };
  return { runner, work, address };
}

describe("teleport", () => {
  it("moves a thread's commits and conversation to another runner, once, without overwriting work", async () => {
    const source = mkdtempSync(join(tmpdir(), "lemonlime-tp-src-"));
    cleanups.push(() => rmSync(source, { recursive: true, force: true }));
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "notes.md"), "start\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "init");

    const fromPrompts: string[] = [];
    const from = await runnerFor("tp-from-thread", source, fromPrompts);
    from.runner.sendMessage("first idea");
    await from.runner.settled();
    from.runner.sendMessage("second idea");
    await from.runner.settled();

    const toPrompts: string[] = [];
    const to = await runnerFor("tp-to-thread", source, toPrompts);
    expect(await teleportThread({ from: from.address, to: to.address, fromLabel: "computer" })).toEqual({ already: false });

    expect(readFileSync(join(to.work, "notes.md"), "utf8")).toBe("start\nfirst idea\nsecond idea\n");
    expect(git(to.work, "rev-parse", "HEAD")).toBe(git(from.work, "rev-parse", "HEAD"));
    const texts = to.runner.store
      .since(0)
      .filter(e => e.type === "user_message")
      .map(e => (e as { text: string }).text);
    expect(texts).toEqual(["first idea", "second idea"]);
    expect(to.runner.store.since(0).some(e => e.type === "notice" && e.code === "teleported")).toBe(true);

    // The agent there carries on the same conversation.
    to.runner.sendMessage("third idea");
    await to.runner.settled();
    expect(toPrompts[0]).toContain("moved here from another computer");
    expect(toPrompts[0]).toContain("User: second idea");
    expect(readFileSync(join(to.work, "notes.md"), "utf8")).toBe("start\nfirst idea\nsecond idea\nthird idea\n");

    // Moving again into a thread that now has work of its own is refused; nothing changes.
    await expect(teleportThread({ from: from.address, to: to.address, fromLabel: "computer" })).rejects.toThrow(/work of its own/);
    expect(readFileSync(join(to.work, "notes.md"), "utf8")).toBe("start\nfirst idea\nsecond idea\nthird idea\n");
  });

  it("imports a transfer once, and only when its files match the checksum", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "lemonlime-tp-marks-"));
    cleanups.push(() => rmSync(markerDir, { recursive: true, force: true }));
    const history = Buffer.from(JSON.stringify([{ type: "user_message", text: "hi", threadId: "x", seq: 1, at: new Date().toISOString() }]));
    const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const checksum = `${hash(Buffer.alloc(0))}:${hash(history)}`;
    const transferId = randomUUID();
    const base = { git: null, baseBranch: "main", transferId, bundle: null, history, markerDir };
    expect(await importThread({ ...base, checksum: `${hash(Buffer.alloc(0))}:${"0".repeat(64)}` })).toMatchObject({ ok: false, status: 422 });
    expect(await importThread({ ...base, checksum })).toMatchObject({ ok: true, already: false, events: [{ type: "user_message", text: "hi" }] });
    expect(await importThread({ ...base, checksum })).toMatchObject({ ok: true, already: true, events: [] });
  });
});
