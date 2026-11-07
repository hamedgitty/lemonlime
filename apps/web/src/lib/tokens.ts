import { ThreadId, deriveThreadSecret, signToken, verifyToken } from "@lemonlime/protocol";
import { bearerToken } from "./access-tokens.ts";

/**
 * Runners sign their own tokens, a few minutes ahead. One that claims to last longer
 * was made to be kept, so it's refused.
 */
export const MAX_RUNNER_TOKEN_SECONDS = 10 * 60;

/** Client tokens are short-lived; clients fetch a fresh one on every (re)connect. */
export const CLIENT_TOKEN_TTL_SECONDS = 15 * 60;

/** The per-thread secret the runner receives as LEMONLIME_THREAD_SECRET. */
export function threadSecret(masterSecret: string, threadId: string): Promise<string> {
  return deriveThreadSecret(masterSecret, threadId);
}

/** A `client` token that lets `userId` open the thread's WebSocket for 15 minutes. */
export async function issueClientToken(opts: {
  masterSecret: string;
  threadId: string;
  userId: string;
  nowMs?: number;
}): Promise<{ token: string; expiresAt: string }> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const exp = nowSec + CLIENT_TOKEN_TTL_SECONDS;
  const secret = await threadSecret(opts.masterSecret, opts.threadId);
  const token = await signToken({ threadId: opts.threadId, scope: "client", exp, sub: opts.userId }, secret);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export type RunnerAuthResult = { ok: true; threadId: string } | { ok: false; status: 401 | 403; error: string };

/**
 * Checks `Authorization: Bearer <runner token>` for a heartbeat about `threadId`.
 * The token must be signed with that thread's secret and carry the `runner` scope,
 * so a runner can only ever report on its own thread.
 */
export async function authenticateRunner(
  authorization: string | null | undefined,
  threadId: string,
  masterSecret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<RunnerAuthResult> {
  const token = bearerToken(authorization);
  if (!token) return { ok: false, status: 401, error: "missing bearer token" };
  if (!ThreadId.safeParse(threadId).success) return { ok: false, status: 401, error: "invalid thread id" };
  const secret = await threadSecret(masterSecret, threadId);
  const result = await verifyToken(token, secret, nowSec);
  if (!result.ok) return { ok: false, status: 401, error: `token ${result.reason.replace("_", " ")}` };
  if (result.claims.scope !== "runner") return { ok: false, status: 403, error: "token is not a runner token" };
  if (result.claims.threadId !== threadId) return { ok: false, status: 403, error: "token is for another thread" };
  if (result.claims.exp > nowSec + MAX_RUNNER_TOKEN_SECONDS) return { ok: false, status: 401, error: "token lives too long" };
  return { ok: true, threadId };
}
