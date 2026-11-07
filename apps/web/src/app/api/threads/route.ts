import { requestWorkspace } from "@/lib/current-workspace.ts";
import { CreateThreadRequest } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { createThread, listThreads } from "@/lib/threads.ts";
import { enforce, LIMITS } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

/** List threads in a workspace (`?workspace=<id>`, default: the user's first workspace). */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ workspaceId, threads: await listThreads(ctx, user.userId, workspaceId) });
});

/** Create a thread. Cloud threads start a sandbox; local threads are recorded for the desktop app. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const body = await parseBody(request, CreateThreadRequest);
  await enforce(ctx.db, `threads:${user.userId}`, LIMITS.threadsPerUser, "new threads");
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json(await createThread(ctx, user.userId, workspaceId, body), 201);
});
