import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, signToken, type Thread } from "@lemonlime/protocol";
import { recapBefore, startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

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
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe("rewind", () => {
  it("goes back to an earlier message, puts the files back, and starts the agent afresh with a recap", async () => {
    const source = mkdtempSync(join(tmpdir(), "lemonlime-rewind-src-"));
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "notes.md"), "start\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "init");
    const work = join(mkdtempSync(join(tmpdir(), "lemonlime-rewind-")), "w");
    cleanups.push(() => rmSync(source, { recursive: true, force: true }));

    const prompts: string[] = [];
    let sessions = 0;
    let disposed = 0;
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: opts => {
        sessions++;
        return {
          runTurn: async ctx => {
            prompts.push(ctx.prompt);
            writeFileSync(join(opts.cwd, "notes.md"), `${readFileSync(join(opts.cwd, "notes.md"), "utf8")}${ctx.prompt.split("\n").at(-1)}\n`);
            ctx.emit({ type: "agent_message", text: `Added a line for: ${ctx.prompt.split("\n").at(-1)}` });
          },
          saveState: () => ({ sessionId: `s${sessions}` }),
          dispose: async () => void disposed++,
        };
      },
    };
    const runner = new ThreadRunner({
      thread: thread("rewind-thread-1"),
      workdir: work,
      dataDir: null,
      adapter,
      session: { autonomy: "full" },
      sourceRepo: source,
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    runner.sendMessage("one");
    await runner.settled();
    runner.sendMessage("two");
    await runner.settled();
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("start\none\ntwo\n");

    const second = runner.store.since(0).find(e => e.type === "user_message" && e.text === "two")!;
    expect((second as { commit?: string }).commit).toBe(git(work, "rev-parse", "HEAD~1"));
    const before = git(work, "rev-parse", "HEAD");
    expect(await runner.rewind(second.seq, true)).toEqual({ text: "two" });
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("start\none\n");
    const rewind = runner.store.since(0).find(e => e.type === "rewind") as { backupRef: string; restoredTo: string };
    expect(git(work, "rev-parse", rewind.backupRef)).toBe(before); // nothing is lost
    expect(disposed).toBe(1);

    runner.sendMessage("two, but different");
    await runner.settled();
    expect(sessions).toBe(2);
    expect(prompts[2]).toContain("This conversation was rewound");
    expect(prompts[2]).toContain("User: one");
    expect(prompts[2]).not.toContain("User: two\n");
    expect(prompts[2]!.endsWith("two, but different")).toBe(true);
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("start\none\ntwo, but different\n");

    const reply = runner.store.since(0).find(e => e.type === "agent_message")!;
    expect(await runner.rewind(reply.seq, false)).toEqual({ error: "That isn't one of your messages." });
  });

  it("holds a message sent while going back until the thread is ready for it", async () => {
    const source = mkdtempSync(join(tmpdir(), "lemonlime-rewind-src-"));
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "notes.md"), "start\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "init");
    const work = join(mkdtempSync(join(tmpdir(), "lemonlime-rewind-")), "w");
    cleanups.push(() => rmSync(source, { recursive: true, force: true }));

    const ran: { prompt: string; session: number; notes: string }[] = [];
    const gone = new Set<number>();
    let sessions = 0;
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: opts => {
        const session = ++sessions;
        return {
          runTurn: async ctx => {
            if (gone.has(session)) throw new Error("this conversation was already closed");
            ran.push({ prompt: ctx.prompt, session, notes: readFileSync(join(opts.cwd, "notes.md"), "utf8") });
            writeFileSync(join(opts.cwd, "notes.md"), `${readFileSync(join(opts.cwd, "notes.md"), "utf8")}${ctx.prompt.split("\n").at(-1)}\n`);
          },
          saveState: () => ({}),
          // Closing takes a moment, as it does with a real agent.
          dispose: async () => {
            await new Promise(r => setTimeout(r, 30));
            gone.add(session);
          },
        };
      },
    };
    const runner = new ThreadRunner({
      thread: thread("rewind-thread-2"),
      workdir: work,
      dataDir: null,
      adapter,
      session: { autonomy: "full" },
      sourceRepo: source,
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    runner.sendMessage("one");
    await runner.settled();
    runner.sendMessage("two");
    await runner.settled();

    const second = runner.store.since(0).find(e => e.type === "user_message" && e.text === "two")!;
    const goingBack = runner.rewind(second.seq, true);
    expect(runner.sendMessage("two, but different").result).toBe("queued");
    expect(await runner.rewind(second.seq, true)).toHaveProperty("error");
    expect(await goingBack).toEqual({ text: "two" });
    await runner.settled();

    // It ran once, after the files were put back, in the fresh conversation with the recap.
    expect(ran).toHaveLength(3);
    expect(ran[2]!.session).toBe(2);
    expect(ran[2]!.notes).toBe("start\none\n");
    expect(ran[2]!.prompt).toContain("This conversation was rewound");
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("start\none\ntwo, but different\n");
    const visible = runner.store.since(0);
    const rewindSeq = visible.find(e => e.type === "rewind")!.seq;
    expect(visible.find(e => e.type === "user_message" && e.text === "two, but different")!.seq).toBeGreaterThan(rewindSeq);
  });

  it("leaves rewound-past messages out of later recaps", () => {
    const at = new Date().toISOString();
    const base = { threadId: "t-recap-1", at };
    const events = [
      { ...base, seq: 1, type: "user_message", text: "a" },
      { ...base, seq: 2, type: "agent_message", text: "did a", partial: false },
      { ...base, seq: 3, type: "user_message", text: "b" },
      { ...base, seq: 4, type: "rewind", toSeq: 3 },
      { ...base, seq: 5, type: "user_message", text: "c" },
    ] as Parameters<typeof recapBefore>[0];
    const recap = recapBefore(events, 6)!;
    expect(recap).toContain("User: a");
    expect(recap).toContain("You: did a");
    expect(recap).toContain("User: c");
    expect(recap).not.toContain("User: b");
    expect(recapBefore(events, 1)).toBeNull();
  });
});

describe("the reply when going back fails", () => {
  const SECRET = "thread-secret-for-rewind-tests-0123";

  /** A client connected to the runner: what it was sent, and a way to wait for the next error. */
  async function connect(runner: ThreadRunner, id: string) {
    const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
    const token = await signToken({ threadId: id, scope: "client", sub: "user-1", exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(
      () => server.close(),
      () => ws.terminate(),
    );
    const got: Array<{ type: string; code?: string; message?: string }> = [];
    const waiting: Array<() => void> = [];
    ws.on("message", raw => {
      got.push(JSON.parse(raw.toString()) as (typeof got)[number]);
      for (const w of waiting.splice(0)) w();
    });
    const until = async (test: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!test()) {
        if (Date.now() > deadline) throw new Error(`still waiting after ${JSON.stringify(got.map(m => m.type))}`);
        await new Promise<void>(r => {
          waiting.push(r);
          setTimeout(r, 100);
        });
      }
    };
    await new Promise(r => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", token, resumeFrom: 0 }));
    await until(() => got.some(m => m.type === "caught_up"));
    const errors = () => got.filter(m => m.type === "error");
    return {
      async ask(message: Record<string, unknown>) {
        const before = errors().length;
        ws.send(JSON.stringify(message));
        await until(() => errors().length > before);
        return errors().at(-1)!;
      },
      async stillOpen() {
        ws.send(JSON.stringify({ type: "ping" }));
        await until(() => got.some(m => m.type === "pong"));
        return ws.readyState === WebSocket.OPEN;
      },
    };
  }

  it("says why when there is nothing to go back to", async () => {
    const id = "rewind-thread-4";
    const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
    const work = mkdtempSync(join(tmpdir(), "lemonlime-rewind-"));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const runner = new ThreadRunner({
      thread: thread(id),
      workdir: work,
      dataDir: null,
      adapter: idle,
      session: { autonomy: "full" },
      git: false,
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    runner.sendMessage("one");
    await runner.settled();
    const client = await connect(runner, id);

    expect(await client.ask({ type: "rewind", toSeq: 999, restoreFiles: false })).toMatchObject({
      code: "bad_request",
      message: "That isn't one of your messages.",
    });
    const first = runner.store.since(0).find(e => e.type === "user_message")!;
    // Without git no point was saved, so the files can't be put back.
    expect(await client.ask({ type: "rewind", toSeq: first.seq, restoreFiles: true })).toMatchObject({
      code: "bad_request",
      message: "There's no saved point to restore files to for that message.",
    });
    expect(runner.store.since(0).some(e => e.type === "rewind")).toBe(false);
  });

  it("says what went wrong when the files couldn't be put back, and can go back once they can", async () => {
    const id = "rewind-thread-5";
    const source = mkdtempSync(join(tmpdir(), "lemonlime-rewind-src-"));
    git(source, "init", "-q", "-b", "main");
    writeFileSync(join(source, "notes.md"), "start\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "init");
    const work = join(mkdtempSync(join(tmpdir(), "lemonlime-rewind-")), "w");
    cleanups.push(() => rmSync(source, { recursive: true, force: true }));
    const adapter: AgentAdapter = {
      kind: "claude-code",
      createSession: opts => ({
        runTurn: async ctx =>
          writeFileSync(join(opts.cwd, "notes.md"), `${readFileSync(join(opts.cwd, "notes.md"), "utf8")}${ctx.prompt.split("\n").at(-1)}\n`),
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = new ThreadRunner({
      thread: thread(id),
      workdir: work,
      dataDir: null,
      adapter,
      session: { autonomy: "full" },
      sourceRepo: source,
      bundledSkills: false,
    });
    await runner.init();
    cleanups.push(() => runner.close());
    runner.sendMessage("one");
    await runner.settled();
    runner.sendMessage("two");
    await runner.settled();
    const second = runner.store.since(0).find(e => e.type === "user_message" && e.text === "two")!;
    const client = await connect(runner, id);

    // Git refuses to change the files while another git command holds this lock.
    const lock = join(git(work, "rev-parse", "--absolute-git-dir"), "index.lock");
    writeFileSync(lock, "");
    const reply = await client.ask({ type: "rewind", toSeq: second.seq, restoreFiles: true });
    expect(reply.code).toBe("internal");
    expect(reply.message).toMatch(/^Could not go back: /);
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("start\none\ntwo\n");
    expect(runner.store.since(0).some(e => e.type === "rewind")).toBe(false);
    expect(await client.stillOpen()).toBe(true);

    rmSync(lock);
    expect(await runner.rewind(second.seq, true)).toEqual({ text: "two" });
    expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("start\none\n");
  });
});
