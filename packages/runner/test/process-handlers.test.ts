import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** What the running runner does about errors nobody caught, and about being told to stop. */

const SECRET = "b".repeat(64);
const BIN = resolve(__dirname, "../bin/lemonlime-runner.js");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Started {
  child: ChildProcessWithoutNullStreams;
  /** Everything it has printed so far. */
  output: () => string;
  port: Promise<number>;
  exited: Promise<number | null>;
}

/** Start the real runner. `preload` is a script loaded into it first, to make something go wrong inside it. */
function startRunner(preload?: string): Started {
  const home = mkdtempSync(join(tmpdir(), "runner-process-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, LEMONLIME_HOME: join(home, ".lemonlime"), LEMONLIME_THREAD_SECRET: SECRET };
  delete env.LEMONLIME_KEEPER;
  if (preload) {
    const file = join(home, "preload.mjs");
    writeFileSync(file, preload);
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(file).href}`].filter(Boolean).join(" ");
  }
  const child = spawn(
    process.execPath,
    [BIN, "--thread", "process-thread-1", "--agent", "claude-code", "--no-git", "--workdir", join(home, "work"), "--port", "0"],
    {
      env,
    },
  );
  let printed = "";
  const exited = new Promise<number | null>(r => child.on("exit", code => r(code)));
  const port = new Promise<number>((resolve, reject) => {
    const look = (d: unknown) => {
      printed += String(d);
      const m = /"event":"ready","port":(\d+)/.exec(printed);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    void exited.then(code => reject(new Error(`runner exited (${code}): ${printed}`)));
  });
  port.catch(() => undefined);
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await exited;
    rmSync(home, { recursive: true, force: true });
  });
  return { child, output: () => printed, port, exited };
}

async function until(test: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting. ${what()}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

const alive = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ok: boolean }).ok;

describe.skipIf(process.platform === "win32")("the running runner", () => {
  it("keeps serving after an error nobody caught, and says what it was", { timeout: 30_000 }, async () => {
    const runner = startRunner(`
      process.on("SIGUSR2", () => {
        setTimeout(() => {
          throw new Error("thrown where nothing catches it");
        }, 0);
        void Promise.reject(new Error("a promise nobody waited for"));
      });
    `);
    const port = await runner.port;
    runner.child.kill("SIGUSR2");
    await until(() => runner.output().includes("thrown where nothing catches it") && runner.output().includes("a promise nobody waited for"), runner.output);
    expect(runner.output().match(/unexpected error, still running/g)).toHaveLength(2);
    expect(await alive(port)).toBe(true);
    expect(runner.child.exitCode).toBeNull();
  });

  it("stops when an error nobody caught happens before it is ready", { timeout: 30_000 }, async () => {
    const runner = startRunner(`
      setTimeout(() => {
        throw new Error("broke while starting");
      }, 0);
    `);
    expect(await runner.exited).not.toBe(0);
    expect(runner.output()).not.toContain('"event":"ready"');
    expect(runner.output()).not.toContain("still running");
  });

  it.each(["SIGTERM", "SIGINT"] as const)("stops cleanly when sent %s", { timeout: 30_000 }, async signal => {
    const runner = startRunner();
    const port = await runner.port;
    expect(await alive(port)).toBe(true);
    runner.child.kill(signal);
    expect(await runner.exited).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
