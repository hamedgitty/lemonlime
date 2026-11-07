import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { readHistory } from "@/lib/history.ts";
import { json, route } from "@/lib/http.ts";
import { getThreadRowForUser } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * The thread's stored history after `?after=<seq>` (default 0), oldest first. Works while
 * the sandbox is paused or gone, without waking it.
 */
export const GET = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const row = await getThreadRowForUser(ctx, user.userId, (await params).id);
  const after = Math.max(0, Number.parseInt(new URL(request.url).searchParams.get("after") ?? "0", 10) || 0);
  return json(await readHistory(ctx, row.id, after));
});
