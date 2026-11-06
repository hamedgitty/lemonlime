import { CreateThreadRequest } from "@lemonlime/protocol";
import { requireUser, resolveWorkspace } from "@/lib/auth.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { createThread, listThreads } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/** List threads in a workspace (`?workspace=<id>`, default: the user's first workspace). */
export const GET = route(async request => {
  const user = await requireUser(request);
  const workspaceId = await resolveWorkspace(user.userId, new URL(request.url).searchParams.get("workspace"));
  return json({ workspaceId, threads: await listThreads(workspaceId) });
});

/** Create a thread. Cloud threads start a sandbox; local threads are recorded for the desktop app. */
export const POST = route(async request => {
  const user = await requireUser(request);
  const body = await parseBody(request, CreateThreadRequest);
  const workspaceId = await resolveWorkspace(user.userId, new URL(request.url).searchParams.get("workspace"));
  return json(await createThread(user.userId, workspaceId, body), 201);
});
