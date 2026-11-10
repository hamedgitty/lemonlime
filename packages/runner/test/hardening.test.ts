import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { AgentError, capEvent, fixHint, lineSplitter, runLineProcess, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-hard-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "init", "--allow-empty"], { cwd: dir });
  return dir;
}

function thread(id: string): Thread {
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "local", baseBranch: "main" },
    branch: branchForThread(id),
    mode: "local",
    status: "provisioning",
    sandboxSize: "small",
    latestSeq: 0,
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function boot(adapter: AgentAdapter, id: string, extra: Partial<ConstructorParameters<typeof ThreadRunner>[0]> = {}) {
  const runner = new ThreadRunner({ thread: thread(id), workdir: repo(), dataDir: null, adapter, session: { autonomy: "edits" }, ...extra });
  await runner.init();
  cleanups.push(() => runner.close());
  return runner;
}

describe("lineSplitter", () => {
  it("splits across chunks, handles CRLF and a last line without a newline", () => {
    const lines: string[] = [];
    const s = lineSplitter(
      l => lines.push(l),
      () => undefined,
    );
    s.write(Buffer.from('{"a":1}\r\n{"b"'));
    s.write(Buffer.from(':2}\n\n  \n{"c":3}'));
    s.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("drops a line that is too long without buffering it, and keeps going", () => {
    const lines: string[] = [];
    const dropped: number[] = [];
    const s = lineSplitter(
      l => lines.push(l),
      b => dropped.push(b),
      10,
    );
    s.write(Buffer.from("short\n" + "x".repeat(8)));
    s.write(Buffer.from("y".repeat(50)));
    s.write(Buffer.from("z\nafter\n"));
    expect(lines).toEqual(["short", "after"]);
    expect(dropped).toEqual([59]);
  });
});

describe("capEvent", () => {
  it("keeps the start of huge output and says how much was left out", () => {
    const big = "x".repeat(300 * 1024);
    const out = capEvent({ type: "tool_result", callId: "c", output: big, isError: false }) as { output: string };
    expect(out.output.length).toBeLessThan(big.length);
    expect(out.output).toMatch(/more characters not kept\]$/);
    const obj = capEvent({ type: "tool_call", callId: "c", name: "x", input: { data: big } }) as { input: unknown };
    expect(typeof obj.input).toBe("string");
    const small = { type: "tool_call" as const, callId: "c", name: "x", input: { path: "a" } };
    expect(capEvent(small)).toEqual(small);
  });
});

describe("runLineProcess", () => {
  it("reports an agent killed from outside as a crash", async () => {
    const err = await runLineProcess({
      command: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
      cwd: tmpdir(),
      signal: new AbortController().signal,
      onLine: () => undefined,
    }).catch(e => e as AgentError);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("agent_crashed");
  });
});

describe("ThreadRunner hardening", () => {
  it("tells the user when the agent goes quiet, once per quiet spell", async () => {
    const quiet: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({ runTurn: () => new Promise(r => setTimeout(r, 250)), saveState: () => ({}), dispose: async () => {} }),
    };
    const runner = await boot(quiet, "quiet-thread-1", { quietNoticeMs: 60 });
    runner.sendMessage("build everything");
    await runner.settled();
    const notices = runner.store.since(0).filter(e => e.type === "notice" && e.code === "agent_quiet");
    expect(notices).toHaveLength(1);
  });

  it("stops a turn that runs past the time limit and keeps going afterwards", async () => {
    const forever: AgentAdapter = {
      kind: "claude-code",
      createSession: () => ({
        runTurn: ctx => new Promise<void>(r => ctx.signal.addEventListener("abort", () => r())),
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = await boot(forever, "timeout-thread-1", { turnTimeoutMs: 80 });
    runner.sendMessage("never ends");
    await runner.settled();
    const events = runner.store.since(0);
    expect(events.find(e => e.type === "error" && e.code === "turn_timeout")).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "status_change", to: "idle", reason: "timed out" });
  });

  it("restarts a crashed agent once, then reports process_lost, and starts fresh on the next message", async () => {
    let sessions = 0;
    const outcomes = ["crash", "crash", "ok", "crash", "ok"];
    const crashy: AgentAdapter = {
      kind: "claude-code",
      createSession: () => {
        sessions += 1;
        return {
          runTurn: async () => {
            if (outcomes.shift() === "crash") throw new AgentError("claude stopped unexpectedly (SIGKILL)", "agent_crashed");
          },
          saveState: () => ({ sessionId: "s-1" }),
          dispose: async () => {},
        };
      },
    };
    const runner = await boot(crashy, "crash-thread-2");
    const codes = () => runner.store.since(0).flatMap(e => (e.type === "error" || e.type === "notice" ? [e.code] : []));

    runner.sendMessage("one");
    await runner.settled();
    expect(codes()).toEqual(["agent_crashed", "agent_restarted"]);
    expect(sessions).toBe(2);

    runner.sendMessage("two");
    await runner.settled();
    expect(codes().at(-1)).toBe("process_lost");
    expect(sessions).toBe(2); // not restarted again on its own

    runner.sendMessage("three");
    await runner.settled();
    expect(sessions).toBe(3); // the user's message starts it fresh
    expect(codes().at(-1)).toBe("process_lost");

    // A success in between resets the count, so the next crash is restarted again.
    runner.sendMessage("four");
    await runner.settled();
    expect(codes().at(-1)).toBe("agent_restarted");
  });

  it("adds a plain fix to sign-in and outdated-CLI errors", async () => {
    const signedOut: AgentAdapter = {
      kind: "codex",
      createSession: () => ({
        runTurn: async () => {
          throw new AgentError("unexpected status 401 Unauthorized", "auth_required");
        },
        saveState: () => ({}),
        dispose: async () => {},
      }),
    };
    const runner = await boot(signedOut, "auth-thread-1");
    runner.sendMessage("hi");
    await runner.settled();
    const err = runner.store.since(0).find(e => e.type === "error") as { message: string; code: string };
    expect(err.code).toBe("auth_required");
    expect(err.message).toContain("`codex login`");
    expect(fixHint("agent_outdated", "claude-code")).toContain("`claude update`");
    expect(fixHint("agent_failed", "codex")).toBeNull();
  });
});
