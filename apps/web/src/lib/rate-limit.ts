import { getIP } from "better-auth/api";
import { sql } from "drizzle-orm";
import { rateLimit, type Db } from "@lemonlime/db";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";
import { socketAddress } from "./socket-address.ts";

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

/** The header the Node build writes the caller's address into for the sign-in library, once it has been worked out here. */
export const CALLER_HEADER = "x-lemonlime-caller-address";

/** What callers that can't be told apart are counted as: one caller between them. */
const UNKNOWN_CALLER = "unknown";

/** The header the sign-in library reads the caller's address from: the platform's on Workers, the app's own on Node. */
export function addressHeaders(runtime: "workers" | "node"): string[] {
  return runtime === "workers" ? ["cf-connecting-ip"] : [CALLER_HEADER];
}

/**
 * How many reverse proxies stand in front of the app on Node (LEMONLIME_TRUSTED_PROXIES).
 * None unless it says so: anyone can send X-Forwarded-For, so it is only believed when
 * something in front of the app is known to write it.
 */
export function trustedProxies(vars: Record<string, string | undefined>): number {
  const count = Number(vars.LEMONLIME_TRUSTED_PROXIES?.trim() || 0);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * The address the caller is reported to have, before it is checked. On Workers the
 * platform says. On Node, each trusted proxy adds the address it heard from to the end of
 * X-Forwarded-For, so with one proxy the last entry is the caller, with two the one before
 * it, and anything further left could have been written by the caller. With no proxy to
 * trust, it is where the connection came from, when the server wrote that down.
 */
function reportedAddress(ctx: Pick<AppContext, "runtime" | "vars">, headers: Headers): string | null {
  if (ctx.runtime === "workers") return headers.get("cf-connecting-ip");
  const proxies = trustedProxies(ctx.vars);
  if (proxies === 0) return socketAddress(headers);
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
  return chain[chain.length - proxies] ?? null;
}

const ONE_ADDRESS = "x-address";
let saidCallersAreShared = false;

/**
 * Where a request came from, for counting. Callers that can't be told apart share one
 * count. IPv6 addresses count by network, so one network is one caller.
 */
export function callerAddress(ctx: Pick<AppContext, "runtime" | "vars" | "production">, request: Request | Headers): string {
  const reported = reportedAddress(ctx, request instanceof Headers ? request : request.headers);
  if (!reported) {
    if (ctx.runtime === "node" && ctx.production && !saidCallersAreShared) {
      saidCallersAreShared = true;
      console.warn(
        "[lemonlime] Callers can't be told apart, so they share one allowance for sign-in codes and webhook calls. Start the app with server.ts, or set LEMONLIME_TRUSTED_PROXIES if it runs behind a reverse proxy.",
      );
    }
    return UNKNOWN_CALLER;
  }
  // The sign-in library's own reading of one address, so both count a caller the same way.
  return getIP(new Headers({ [ONE_ADDRESS]: reported }), { advanced: { ipAddress: { ipAddressHeaders: [ONE_ADDRESS] } } }) ?? UNKNOWN_CALLER;
}

/**
 * The request as the sign-in library should see it. On Node the caller's address is
 * written where the library reads it, replacing whatever the caller sent under that name;
 * a caller that can't be told apart gets none, and the library counts those together.
 * On Workers the platform's own header is read as it is.
 */
export function withCallerAddress(ctx: Pick<AppContext, "runtime" | "vars" | "production">, request: Request): Request {
  if (ctx.runtime === "workers") return request;
  const headers = new Headers(request.headers);
  const address = callerAddress(ctx, headers);
  if (address === UNKNOWN_CALLER) headers.delete(CALLER_HEADER);
  else headers.set(CALLER_HEADER, address);
  return new Request(request, { headers });
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
