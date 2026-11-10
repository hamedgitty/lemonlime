import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, requireSameSite, route } from "@/lib/http.ts";
import { deleteThreadForever } from "@/lib/account.ts";
import { deleteThread, getThreadRowForUser, ThreadChange, threadResponse, updateThread } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * The thread, for any member of its workspace. Those who may take part in it (the person
 * who started it, or everyone once it is shared) also get a fresh runner endpoint and
 * client token while its sandbox runs.
 */
export const GET = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const row = await getThreadRowForUser(ctx, user.userId, (await params).id);
  return json(await threadResponse(ctx, row, user.userId));
});

/** Rename the thread, or (its starter only) let the rest of the workspace take part in it. */
export const PATCH = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const body = await parseBody(request, ThreadChange);
  return json(await updateThread(ctx, user.userId, (await params).id, body));
});

/**
 * Close the thread and destroy its sandbox. With `?forever=1`, also delete its stored
 * history and the thread itself. Either way, only the person who started it or a
 * workspace owner may.
 */
export const DELETE = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const id = (await params).id;
  if (new URL(request.url).searchParams.get("forever") === "1") {
    // A desktop app sends its token from its own origin; a browser session must be on this site.
    if (user.via === "session") requireSameSite(request);
    await deleteThreadForever(ctx, user.userId, id);
    return json({ ok: true });
  }
  return json(await deleteThread(ctx, user.userId, id));
});
