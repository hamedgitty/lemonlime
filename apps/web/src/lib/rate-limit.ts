import { getIP } from "better-auth/api";
import { sql } from "drizzle-orm";
import { rateLimit, type Db } from "@lemonlime/db";
import { HttpError } from "./errors.ts";

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
}

/** Limits for the app's own endpoints. Better Auth's routes are limited in better-auth.ts. */
export const LIMITS = {
  /** Sign-in codes one caller can have emailed to one address... */
  signInCodesPerEmail: { max: 5, windowSeconds: 60 * 60 },
  /** ...and the codes emailed to one address, whoever asked. */
  signInCodesPerEmailFromAnyone: { max: 20, windowSeconds: 60 * 60 },
  /** Personal access tokens one user can create. */
  tokensPerUser: { max: 10, windowSeconds: 60 * 60 },
  /** Threads one user can create, and cloud sandboxes one user can start or resume. */
  threadsPerUser: { max: 30, windowSeconds: 60 },
  sandboxStartsPerUser: { max: 30, windowSeconds: 60 },
  /** Messages one user can send to threads whose agent isn't connected to them live. */
  messagesPerUser: { max: 60, windowSeconds: 60 },
  /** Phone bridge links one user's desktop apps can open or renew (a few per computer each 15 minutes). */
  phoneLinks: { max: 30, windowSeconds: 60 },
} satisfies Record<string, Limit>;

/** The header that carries the caller's address: the platform's on Workers, the proxy's on Node. */
export function addressHeaders(runtime: "workers" | "node"): string[] {
  return runtime === "workers" ? ["cf-connecting-ip"] : ["x-forwarded-for"];
}

/**
 * Where a request came from, for counting. A header that lists several addresses could
 * have been started by the caller, so it isn't believed; callers that can't be told apart
 * share "unknown". IPv6 addresses count by network, so one network is one caller.
 */
export function callerAddress(runtime: "workers" | "node", request: Request | Headers): string {
  return getIP(request, { advanced: { ipAddress: { ipAddressHeaders: addressHeaders(runtime) } } }) ?? "unknown";
}

/**
 * Count one request against `key` and say whether it is allowed. Fixed windows, stored
 * in the `rate_limit` table, so every Worker isolate sees the same counts. One atomic
 * upsert: two requests at the same moment can't both slip under the limit.
 */
export async function hit(db: Db, key: string, limit: Limit, now = Date.now()): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  const windowMs = limit.windowSeconds * 1000;
  const fullKey = `app:${key}`;
  const [row] = await db
    .insert(rateLimit)
    .values({ id: crypto.randomUUID(), key: fullKey, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`case when ${now} - ${rateLimit.lastRequest} >= ${windowMs} then 1 else ${rateLimit.count} + 1 end`,
        lastRequest: sql`case when ${now} - ${rateLimit.lastRequest} >= ${windowMs} then ${now} else ${rateLimit.lastRequest} end`,
      },
    })
    .returning({ count: rateLimit.count, lastRequest: rateLimit.lastRequest });
  const count = row?.count ?? 1;
  const started = row?.lastRequest ?? now;
  return { ok: count <= limit.max, retryAfterSeconds: Math.max(1, Math.ceil((started + windowMs - now) / 1000)) };
}

/** Like `hit`, but throws a 429 with a plain message when the limit is reached. */
export async function enforce(db: Db, key: string, limit: Limit, what: string): Promise<void> {
  const r = await hit(db, key, limit);
  if (!r.ok) {
    const wait = r.retryAfterSeconds >= 120 ? `${Math.ceil(r.retryAfterSeconds / 60)} minutes` : `${r.retryAfterSeconds} seconds`;
    throw new HttpError(429, `Too many ${what}. Try again in ${wait}.`, { retryAfterSeconds: r.retryAfterSeconds });
  }
}
