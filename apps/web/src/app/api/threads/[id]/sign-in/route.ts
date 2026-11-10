import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { requestAgentSignIn } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * The person who started the thread is about to sign its agent in. The sign-in its sandbox
 * then saves (so their next sandboxes start signed in) is only accepted for a while after
 * this, so code in the sandbox can't quietly swap in a login of its own at some other time.
 * The login is saved to that person's account, so nobody else in the workspace may ask.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  await requestAgentSignIn(ctx, user.userId, (await params).id);
  return json({ ok: true });
});
