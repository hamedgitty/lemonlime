import { HeartbeatResponse, RunnerHeartbeat } from "@lemonlime/protocol";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { recordHeartbeat } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/** Runner → control plane. Auth: `Bearer <runner token>` signed with the thread's secret. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const heartbeat = await parseBody(request, RunnerHeartbeat);
  const auth = await authenticateRunner(request.headers.get("authorization"), heartbeat.threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  return json(HeartbeatResponse.parse(await recordHeartbeat(ctx, heartbeat)));
});
