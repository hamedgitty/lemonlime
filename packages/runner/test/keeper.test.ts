import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAgentKey, signToken, verifyToken } from "@lemonlime/protocol";
import { serveKeys } from "../src/keeper.ts";
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
});
