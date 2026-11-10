import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { recapBefore, ThreadRunner, type AgentAdapter } from "../src/index.ts";

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
