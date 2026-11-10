import { desktopApprovals, type Db } from "@lemonlime/db";
import { createAccessTokenRow } from "./access.ts";
import { generateAccessToken, hashAccessToken } from "./access-tokens.ts";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";
import { enforce, LIMITS } from "./rate-limit.ts";

/**
 * Signing the desktop app in through the browser. The app opens the dashboard with a random
 * `state`; a signed-in person confirms; the dashboard makes a token for that computer and
 * hands it back through the app's own lemonlime:// link together with the same `state`.
 */

/** What the desktop app sends as its `state`: random, URL-safe, long enough not to be guessed. */
export const DESKTOP_STATE = /^[A-Za-z0-9_-]{16,128}$/;

export const NOT_THIS_SITES_FORM = "This request didn't come from this site.";
export const DESKTOP_LINK_NOT_VALID = "That sign-in link is not valid. Start again from the app.";
export const DESKTOP_LINK_USED = "That sign-in link has already been used. Start again from the app.";

/**
 * Whether the confirmation was posted by this site's own form. Browsers name the page a
 * form was posted from; a request that names another site, or none, is not the form.
 */
export function isFromOwnForm(request: Request, publicUrl: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(publicUrl).origin;
}

/**
 * Note that a sign-in link has been used, so it makes one token and no more: going back
 * and confirming again, or replaying the request, is refused. Only a hash of it is kept.
 */
export async function markDesktopLinkUsed(db: Db, state: string): Promise<void> {
  const first = await db
    .insert(desktopApprovals)
    .values({ stateHash: hashAccessToken(state) })
    .onConflictDoNothing()
    .returning({ stateHash: desktopApprovals.stateHash });
  if (first.length === 0) throw new HttpError(409, DESKTOP_LINK_USED);
}

/** Make the desktop app's token for a confirmed sign-in link, and the link that carries it back to the app. */
export async function approveDesktop(ctx: AppContext, userId: string, state: string, now = new Date()): Promise<{ link: string }> {
  if (!DESKTOP_STATE.test(state)) throw new HttpError(400, DESKTOP_LINK_NOT_VALID);
  await enforce(ctx.db, `tokens:${userId}`, LIMITS.tokensPerUser, "new tokens");
  await markDesktopLinkUsed(ctx.db, state);
  const raw = generateAccessToken();
  await createAccessTokenRow(ctx.db, userId, `Desktop app (${now.toISOString().slice(0, 10)})`, hashAccessToken(raw));
  return { link: `lemonlime://auth?${new URLSearchParams({ token: raw, state, url: ctx.config.publicUrl() }).toString()}` };
}
