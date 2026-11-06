import { describe, expect, it } from "vitest";
import { deriveThreadSecret, signToken, verifyToken } from "@lemonlime/protocol";
import { bearerToken, generateAccessToken, hashAccessToken, looksLikeAccessToken, safeEqual } from "../src/lib/access-tokens.ts";
import { CLIENT_TOKEN_TTL_SECONDS, authenticateRunner, issueClientToken } from "../src/lib/tokens.ts";

const MASTER = "test-master-secret-0123456789abcdef";
const THREAD = "thread-aaaaaa";
const NOW = 1_800_000_000;

async function runnerToken(threadId: string, opts: { scope?: "client" | "runner"; exp?: number; secret?: string } = {}) {
  const secret = opts.secret ?? (await deriveThreadSecret(MASTER, threadId));
  return signToken({ threadId, scope: opts.scope ?? "runner", exp: opts.exp ?? NOW + 600 }, secret);
}

describe("authenticateRunner", () => {
  it("accepts a runner token signed with the thread's secret", async () => {
    const token = await runnerToken(THREAD);
    expect(await authenticateRunner(`Bearer ${token}`, THREAD, MASTER, NOW)).toEqual({ ok: true, threadId: THREAD });
  });

  it("rejects a missing or malformed header", async () => {
    expect(await authenticateRunner(null, THREAD, MASTER, NOW)).toMatchObject({ ok: false, status: 401 });
    expect(await authenticateRunner("Basic abc", THREAD, MASTER, NOW)).toMatchObject({ ok: false, status: 401 });
    expect(await authenticateRunner("Bearer not-a-token", THREAD, MASTER, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a token for another thread", async () => {
    const other = await runnerToken("thread-bbbbbb");
    expect(await authenticateRunner(`Bearer ${other}`, THREAD, MASTER, NOW)).toMatchObject({ ok: false, status: 401 });
    // Even signed with the right secret, the claims must name this thread.
    const mismatched = await signToken(
      { threadId: "thread-bbbbbb", scope: "runner", exp: NOW + 600 },
      await deriveThreadSecret(MASTER, THREAD),
    );
    expect(await authenticateRunner(`Bearer ${mismatched}`, THREAD, MASTER, NOW)).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects client tokens, expired tokens and other deployments' tokens", async () => {
    expect(await authenticateRunner(`Bearer ${await runnerToken(THREAD, { scope: "client" })}`, THREAD, MASTER, NOW)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await authenticateRunner(`Bearer ${await runnerToken(THREAD, { exp: NOW - 1 })}`, THREAD, MASTER, NOW)).toMatchObject({
      ok: false,
      status: 401,
    });
    const foreign = await runnerToken(THREAD, { secret: await deriveThreadSecret("another-master-secret-xyz", THREAD) });
    expect(await authenticateRunner(`Bearer ${foreign}`, THREAD, MASTER, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects invalid thread ids before deriving anything", async () => {
    expect(await authenticateRunner("Bearer x.y", "../etc", MASTER, NOW)).toMatchObject({ ok: false, status: 401 });
  });
});

describe("issueClientToken", () => {
  it("issues a 15-minute client token the runner can verify with its thread secret", async () => {
    const { token, expiresAt } = await issueClientToken({ masterSecret: MASTER, threadId: THREAD, userId: "user-1", nowMs: NOW * 1000 });
    expect(Date.parse(expiresAt) / 1000).toBe(NOW + CLIENT_TOKEN_TTL_SECONDS);
    const result = await verifyToken(token, await deriveThreadSecret(MASTER, THREAD), NOW);
    expect(result).toEqual({ ok: true, claims: { threadId: THREAD, scope: "client", exp: NOW + 900, sub: "user-1" } });
    expect((await verifyToken(token, await deriveThreadSecret(MASTER, THREAD), NOW + 901)).ok).toBe(false);
  });
});

describe("personal access tokens", () => {
  it("generates distinct, recognisable tokens", () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    expect(a).not.toBe(b);
    expect(looksLikeAccessToken(a)).toBe(true);
    expect(looksLikeAccessToken("llpat_short")).toBe(false);
    expect(looksLikeAccessToken(`x${a}`)).toBe(false);
  });

  it("stores only a SHA-256 hex hash", () => {
    expect(hashAccessToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const raw = generateAccessToken();
    expect(hashAccessToken(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAccessToken(raw)).not.toContain(raw);
  });

  it("parses bearer headers", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer   abc  ")).toBe("abc");
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Token abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it("compares secrets safely", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("secret", "secret-longer")).toBe(false);
  });
});
