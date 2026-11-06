import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { findUserByTokenHash } from "./access.ts";
import { bearerToken, hashAccessToken, looksLikeAccessToken } from "./access-tokens.ts";
import { getAuth } from "./better-auth.ts";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";

export interface AuthedUser {
  userId: string;
  email: string | null;
  /** How the request authenticated. */
  via: "session" | "token";
}

/**
 * The user behind a request: `Authorization: Bearer <personal access token>`
 * (desktop app) or the Better Auth session cookie (web dashboard).
 */
export async function getUser(ctx: AppContext, request?: Request): Promise<AuthedUser | null> {
  const requestHeaders = request ? request.headers : await headers();
  const bearer = bearerToken(requestHeaders.get("authorization"));
  if (bearer) {
    if (!looksLikeAccessToken(bearer)) return null;
    const userId = await findUserByTokenHash(ctx.db, hashAccessToken(bearer));
    return userId ? { userId, email: null, via: "token" } : null;
  }
  const result = await getAuth(ctx).api.getSession({ headers: requestHeaders });
  if (!result) return null;
  return { userId: result.user.id, email: result.user.email ?? null, via: "session" };
}

export async function requireUser(ctx: AppContext, request?: Request): Promise<AuthedUser> {
  const user = await getUser(ctx, request);
  if (!user) throw new HttpError(401, "Sign in or send a personal access token.");
  return user;
}

/** Only same-site relative paths are allowed as a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** For pages: the signed-in user, or a redirect to /login that comes back to `returnTo`. */
export async function requirePageUser(ctx: AppContext, returnTo = "/"): Promise<AuthedUser> {
  const user = await getUser(ctx);
  if (!user) {
    const next = safeNext(returnTo);
    redirect(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  }
  return user;
}
