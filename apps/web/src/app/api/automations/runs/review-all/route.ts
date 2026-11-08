import { requireUser } from "@/lib/auth.ts";
import { reviewAllRuns } from "@/lib/automations.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** Mark every run of the workspace's automations as reviewed. `?workspace=` picks the workspace. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ ok: true as const, ...(await reviewAllRuns(ctx, workspaceId)) });
});
