import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { pauseThread } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json(await pauseThread(ctx, user.userId, (await params).id));
});
