import { eq } from "drizzle-orm";
import { threads } from "@lemonlime/db";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { getThreadRowForUser } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * A member is about to sign the thread's agent in. The sign-in its sandbox then saves (so
 * the next sandboxes start signed in) is only accepted for a while after this, so code in
 * the sandbox can't quietly swap in a login of its own at some other time.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const row = await getThreadRowForUser(ctx, user.userId, (await params).id);
  if (row.mode !== "cloud") throw new HttpError(400, "Only cloud threads sign in inside a sandbox.");
  await ctx.db.update(threads).set({ signInRequestedAt: new Date().toISOString() }).where(eq(threads.id, row.id));
  return json({ ok: true });
});
