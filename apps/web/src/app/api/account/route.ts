import { z } from "zod";
import { deleteAccount, deletionPreview } from "@/lib/account.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, requireSameSite, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

/** What deleting this account would take with it. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json(await deletionPreview(ctx, user.userId));
});

const DeleteBody = z.object({ confirm: z.string().max(320) });

/**
 * Delete this account and every workspace only it owns. Only from a signed-in browser
 * (not with a personal access token), and only with the account's email typed to confirm.
 */
export const DELETE = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  if (user.via !== "session" || !user.email) throw new HttpError(403, "Delete your account from the dashboard, signed in with your email.");
  requireSameSite(request);
  const { confirm } = await parseBody(request, DeleteBody);
  if (confirm.trim().toLowerCase() !== user.email.toLowerCase()) throw new HttpError(400, "Type your account's email address to confirm.");
  await enforce(ctx.db, `delete-account:${user.userId}`, { max: 5, windowSeconds: 3600 }, "account deletions");
  await deleteAccount(ctx, user.userId);
  const res = json({ ok: true });
  // The session row is gone with the account; drop the cookie too.
  res.headers.append("set-cookie", "better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  res.headers.append("set-cookie", "__Secure-better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  return res;
});
