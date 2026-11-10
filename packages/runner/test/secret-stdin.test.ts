import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { readSecretLine, releaseStdin } from "../src/secret-stdin.ts";

const SECRET = "a".repeat(64);
const BIN = resolve(__dirname, "../bin/lemonlime-runner.js");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("reading the thread secret from stdin", () => {
  it("takes the first line and leaves the rest unread", async () => {
    const input = new PassThrough();
    const got = readSecretLine(input);
    input.write(`${SECRET.slice(0, 10)}`);
    input.write(`${SECRET.slice(10)}\r\nsend_message please\n`);
    expect(await got).toBe(SECRET);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("fails when stdin closes first, a line is far too long, or nothing arrives", async () => {
    const closed = new PassThrough();
    const a = readSecretLine(closed);
    closed.end();
    await expect(a).rejects.toThrow(/closed before/);

    const long = new PassThrough();
    const b = readSecretLine(long);
    long.write("x".repeat(5000));
    await expect(b).rejects.toThrow(/too long/);

    await expect(readSecretLine(new PassThrough(), 20)).rejects.toThrow(/no thread secret/);
  });

  it("closes stdin after the secret, or reports once when the other end closes it", async () => {
    const plain = new PassThrough();
    releaseStdin(plain);
    expect(plain.destroyed).toBe(true);

    const watched = new PassThrough();
    let calls = 0;
    releaseStdin(watched, () => calls++);
    watched.write("ignored\n");
    watched.end();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it("treats stdin breaking after the secret as stdin closing, not as a crash", async () => {
    const input = new PassThrough();
    const got = readSecretLine(input);
    input.write(`${SECRET}\n`);
    expect(await got).toBe(SECRET);
    // The other end goes away before the runner has finished starting.
    input.destroy(new Error("read EIO"));
    await new Promise(r => setTimeout(r, 20));
    let calls = 0;
    releaseStdin(input, () => calls++);
    expect(calls).toBe(1);
  });
});

function startRunner(args: string[]): ChildProcessWithoutNullStreams {
  const home = mkdtempSync(join(tmpdir(), "secret-stdin-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, LEMONLIME_HOME: join(home, ".lemonlime") };
  delete env.LEMONLIME_THREAD_SECRET;
  delete env.LEMONLIME_KEEPER;
  const child = spawn(
    process.execPath,
    [BIN, "--thread", "secret-stdin-1", "--agent", "claude-code", "--no-git", "--workdir", join(home, "work"), "--port", "0", ...args],
    { env },
  );
  cleanups.push(() => {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
  return child;
}

function readyPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
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
}

/** The command line and environment a process was started with, as the system shows them to its own user. */
function startedWith(pid: number): string {
  try {
    return `${readFileSync(`/proc/${pid}/cmdline`, "utf8")}\n${readFileSync(`/proc/${pid}/environ`, "utf8")}`;
  } catch {
    try {
      return execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    } catch {
      return "";
    }
  }
}

const exited = (child: ChildProcessWithoutNullStreams) => new Promise<number | null>(r => child.on("exit", code => r(code)));

describe("lemonlime-runner --secret-stdin", () => {
  it("starts with the secret from stdin and none in its environment or arguments", { timeout: 30_000 }, async () => {
    const child = startRunner(["--secret-stdin"]);
    child.stdin.write(`${SECRET}\n`);
    const port = await readyPort(child);
    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { threadId: string };
    expect(health.threadId).toBe("secret-stdin-1");
    expect(child.spawnargs.join(" ")).not.toContain(SECRET);
    // What another program of the same user can read about the running runner.
    const seen = startedWith(child.pid!);
    expect(seen).toContain("secret-stdin-1");
    expect(seen).not.toContain(SECRET);
  });

  it("refuses a short secret", { timeout: 30_000 }, async () => {
    const child = startRunner(["--secret-stdin"]);
    let err = "";
    child.stderr.on("data", d => (err += String(d)));
    child.stdin.end("short\n");
    expect(await exited(child)).toBe(2);
    expect(err).toContain("at least 16 characters");
  });

  it("with --exit-with-parent, stops when stdin closes (the SSH session ended)", { timeout: 30_000 }, async () => {
    const child = startRunner(["--secret-stdin", "--exit-with-parent"]);
    child.stdin.write(`${SECRET}\n`);
    await readyPort(child);
    child.stdin.end();
    expect(await exited(child)).toBe(0);
  });

  it("prints its version", { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, [BIN, "--version"]);
    let out = "";
    child.stdout.on("data", d => (out += String(d)));
    await new Promise(r => child.on("exit", r));
    expect(out).toMatch(/^lemonlime-runner \d+\.\d+\.\d+/);
  });
});
