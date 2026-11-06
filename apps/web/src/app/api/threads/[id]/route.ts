import { requireUser } from "@/lib/auth.ts";
import { json, route } from "@/lib/http.ts";
import { deleteThread, getThreadRowForUser, threadResponse } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The thread, plus a fresh runner endpoint and client token while its sandbox runs. */
export const GET = route<Context>(async (request, { params }) => {
  const user = await requireUser(request);
  const row = await getThreadRowForUser(user.userId, (await params).id);
  return json(await threadResponse(row, user.userId));
});

/** Close the thread and destroy its sandbox. */
export const DELETE = route<Context>(async (request, { params }) => {
  const user = await requireUser(request);
  return json(await deleteThread(user.userId, (await params).id));
});
