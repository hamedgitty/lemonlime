import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dataDirFor } from "../src/cli.ts";
import { EventStore } from "../src/index.ts";

/** Where a thread's history and state go when the runner isn't told. */

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/lemonlime-runner.js");
const THREAD = "data-dir-thread-1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function folders() {
  const root = mkdtempSync(join(tmpdir(), "lemonlime-data-dir-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home", ".lemonlime");
  const workdir = join(root, "work");
  mkdirSync(workdir, { recursive: true });
  return { root, home, workdir, own: join(home, "threads", THREAD), inWorkdir: join(workdir, ".lemonlime") };
}

/** History as a runner that kept it in the working folder left it. */
function historyInWorkdir(inWorkdir: string, threadId = THREAD): void {
  const store = new EventStore(threadId, join(inWorkdir, "events.jsonl"));
  store.append({ type: "user_message", text: "from before" });
  store.append({ type: "agent_message", text: "noted" });
}

/** Start the real runner without saying where its data goes; resolves with what `/healthz` says. */
async function startRunner(f: ReturnType<typeof folders>): Promise<{ latestSeq: number }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dirname(f.home),
    LEMONLIME_HOME: f.home,
    LEMONLIME_THREAD_SECRET: "thread-secret-for-tests-0123456789",
  };
  delete env.LEMONLIME_KEEPER;
  delete env.LEMONLIME_SANDBOX;
  const child = spawn(
    process.execPath,
    [BIN, "--thread", THREAD, "--agent", "claude-code", "--no-git", "--no-bundled-skills", "--workdir", f.workdir, "--port", "0"],
    {
      env,
    },
  );
  cleanups.push(() => new Promise<void>(r => (child.exitCode === null ? (child.once("exit", () => r()), child.kill("SIGKILL")) : r())));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.on("data", d => {
      out += String(d);
      const m = /"event":"ready","port":(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on("data", d => (err += String(d)));
    child.on("exit", code => reject(new Error(`runner exited (${code}): ${err}`)));
  });
  return (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { latestSeq: number };
}

describe("where a thread's history is kept", () => {
  it("is a folder of the thread's own under the runner's home, outside the folder the agent works in", { timeout: 30_000 }, async () => {
    const f = folders();
    expect(dataDirFor(f.home, f.workdir, THREAD)).toBe(f.own);
    await startRunner(f);
    expect(existsSync(join(f.own, "runner.lock"))).toBe(true);
    expect(existsSync(f.inWorkdir)).toBe(false);
  });

  it("stays in the working folder for a thread that already keeps it there", { timeout: 30_000 }, async () => {
    const f = folders();
    historyInWorkdir(f.inWorkdir);
    expect(dataDirFor(f.home, f.workdir, THREAD)).toBe(f.inWorkdir);
    const health = await startRunner(f);
    // Everything from before is still the thread's history.
    expect(health.latestSeq).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(f.inWorkdir, "runner.lock"))).toBe(true);
    expect(existsSync(f.own)).toBe(false);
  });

  it("is not a .lemonlime folder that came with the repository", () => {
    const f = folders();
    historyInWorkdir(f.inWorkdir, "someone-elses-thread");
    writeFileSync(join(f.inWorkdir, "state.json"), JSON.stringify({ agentState: {}, status: "idle", queue: [] }));
    expect(dataDirFor(f.home, f.workdir, THREAD)).toBe(f.own);
  });

  it("is not a state file on its own, or history that doesn't read as history", () => {
    const f = folders();
    mkdirSync(f.inWorkdir);
    writeFileSync(join(f.inWorkdir, "state.json"), JSON.stringify({ agentState: {}, status: "idle", queue: [] }));
    expect(dataDirFor(f.home, f.workdir, THREAD)).toBe(f.own);
    writeFileSync(join(f.inWorkdir, "events.jsonl"), `not json, though it mentions "threadId":"${THREAD}"\n`);
    expect(dataDirFor(f.home, f.workdir, THREAD)).toBe(f.own);
  });

  it("never goes back to the working folder once the thread has a folder of its own", () => {
    const f = folders();
    mkdirSync(f.own, { recursive: true });
    // Something the agent could write later, made to look like this thread's history.
    historyInWorkdir(f.inWorkdir);
    expect(dataDirFor(f.home, f.workdir, THREAD)).toBe(f.own);
  });
});
