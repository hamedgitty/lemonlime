import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { resumeThread } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/** Resume a paused sandbox. Returns 402 with a PolicyDenied body if the usage policy declines. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json(await resumeThread(ctx, user.userId, (await params).id));
});
