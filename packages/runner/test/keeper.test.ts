import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { deriveAgentKey, signToken, verifyToken } from "@lemonlime/protocol";
import { openKeeperSocket, serveKeys } from "../src/keeper.ts";
import { shellEnv } from "../src/terminal.ts";
import { keeperCall, keysFromKeeper, keysFromSecret } from "../src/keys.ts";

const SECRET = "thread-secret-for-keeper-tests-0123";
const THREAD = "keeper-thread-1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function keeperSocket() {
  const socket = join(mkdtempSync(join(tmpdir(), "keeper-test-")), "k.sock");
  const server = await serveKeys(socket, await keysFromSecret(THREAD, SECRET));
  cleanups.push(() => new Promise(r => server.close(r)));
  return socket;
}

describe("the keeper", () => {
  it("checks tokens and signs short runner tokens for the runner, which never sees the secret", async () => {
    const keys = await keysFromKeeper(await keeperSocket());
    expect(keys.agentKey).toBe(await deriveAgentKey(SECRET));
    const client = await signToken({ threadId: THREAD, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    expect(await keys.verify(client)).toMatchObject({ ok: true, claims: { scope: "client" } });
    expect(
      await keys.verify(await signToken({ threadId: THREAD, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, "another-secret-0123456789")),
    ).toMatchObject({
      ok: false,
    });
    const runner = await verifyToken(await keys.signRunner(9999), SECRET);
    expect(runner).toMatchObject({ ok: true, claims: { scope: "runner", threadId: THREAD } });
    // Capped at 10 minutes however long it's asked for.
    expect(runner.ok && runner.claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
  });

  it("never signs a token for the user's apps, whatever it's asked", async () => {
    const socket = await keeperSocket();
    for (const req of [{ op: "sign", scope: "client" }, { op: "signClient" }, { op: "secret" }]) {
      const answer: { token?: string; error?: string } = await keeperCall<{ token?: string }>(socket, req).catch((e: Error) => ({ error: e.message }));
      if (answer.token) expect(await verifyToken(answer.token, SECRET)).toMatchObject({ ok: true, claims: { scope: "runner" } });
      else expect(answer.error).toBeTruthy();
    }
  });

  it("starts its command without the secret and tells it where the keeper is", async () => {
    const bin = resolve(__dirname, "../bin/lemonlime-runner.js");
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          bin,
          "keeper",
          "--thread",
          THREAD,
          "--",
          process.execPath,
          "-e",
          "console.log(JSON.stringify({ secret: process.env.LEMONLIME_THREAD_SECRET ?? null, keeper: Boolean(process.env.LEMONLIME_KEEPER) }))",
        ],
        { env: { ...process.env, LEMONLIME_THREAD_SECRET: SECRET } },
      );
      let text = "";
      child.stdout.on("data", d => (text += d.toString()));
      child.on("exit", code => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}`))));
    });
    expect(JSON.parse(out.trim())).toEqual({ secret: null, keeper: true });
  });

  it("listens under a name nobody can guess, in a folder nobody else can enter", async () => {
    const keys = await keysFromSecret(THREAD, SECRET);
    const a = await openKeeperSocket(keys);
    const b = await openKeeperSocket(keys);
    for (const k of [a, b])
      cleanups.push(() => {
        k.server.close();
        rmSync(k.dir, { recursive: true, force: true });
      });
    expect(basename(a.socket)).toMatch(/^[\w-]{22}$/);
    expect(basename(a.socket)).not.toBe(basename(b.socket));
    expect(statSync(a.dir).mode & 0o777).toBe(0o700);
    expect(statSync(a.socket).mode & 0o777).toBe(0o600);
    expect((await keysFromKeeper(a.socket)).agentKey).toBe(keys.agentKey);
  });

  it("is not named to the agent its runner starts, or to a terminal", { timeout: 60_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "keeper-agent-"));
    const seen = join(home, "agent-env.json");
    // Stands in for the agent: notes what it was started with, then answers.
    const agent = join(home, "agent.mjs");
    writeFileSync(
      agent,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "readFileSync(0);",
        `writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));`,
        'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" }));',
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, LEMONLIME_HOME: join(home, ".lemonlime"), LEMONLIME_THREAD_SECRET: SECRET };
    delete env.LEMONLIME_SANDBOX;
    const bin = resolve(__dirname, "../bin/lemonlime-runner.js");
    const runner = [bin, "--thread", THREAD, "--agent", "claude-code", "--agent-command", `${process.execPath} ${agent}`, "--no-git"];
    const child = spawn(
      process.execPath,
      [bin, "keeper", "--thread", THREAD, "--", process.execPath, ...runner, "--no-bundled-skills", "--workdir", join(home, "work"), "--port", "0"],
      { env },
    );
    cleanups.push(async () => {
      // The keeper passes the signal on, so the runner it started stops with it.
      const gone = new Promise(done => child.once("exit", done));
      child.kill("SIGTERM");
      await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]);
      child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    });
    const port = await new Promise<number>((resolve, reject) => {
      let out = "";
      let err = "";
      child.stdout.on("data", d => {
        out += String(d);
        const m = /"event":"ready","port":(\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      child.stderr.on("data", d => (err += String(d)));
      child.on("exit", code => reject(new Error(`keeper exited (${code}): ${err}`)));
    });

    const token = await signToken({ threadId: THREAD, scope: "client", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.close());
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, resumeFrom: 0 })));
    ws.on("message", raw => {
      const m = JSON.parse(raw.toString()) as { type: string };
      if (m.type === "welcome") ws.send(JSON.stringify({ type: "send_message", text: "hello", clientMsgId: "keeper-msg-1" }));
    });
    for (let i = 0; i < 400 && !existsSync(seen); i++) await new Promise(r => setTimeout(r, 50));
    const agentEnv = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string>;
    expect(agentEnv.LEMONLIME_AGENT_KEY).toBe(await deriveAgentKey(SECRET));
    expect(agentEnv.LEMONLIME_KEEPER).toBeUndefined();
    expect(agentEnv.LEMONLIME_THREAD_SECRET).toBeUndefined();
    expect(Object.values(agentEnv).join("\n")).not.toContain("lemonlime-keeper-");

    expect(shellEnv({ PATH: "/bin", LEMONLIME_KEEPER: "/tmp/lemonlime-keeper-x/y" }).LEMONLIME_KEEPER).toBeUndefined();
  });
});
