import { requireUser } from "@/lib/auth.ts";
import { json, route } from "@/lib/http.ts";
import { resumeThread } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/** Resume a paused sandbox. Returns 402 with a PolicyDenied body if the usage policy declines. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const user = await requireUser(request);
  return json(await resumeThread(user.userId, (await params).id));
});
