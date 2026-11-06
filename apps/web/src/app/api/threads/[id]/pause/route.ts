import { requireUser } from "@/lib/auth.ts";
import { json, route } from "@/lib/http.ts";
import { pauseThread } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const user = await requireUser(request);
  return json(await pauseThread(user.userId, (await params).id));
});
