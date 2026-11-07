import { requestWorkspace } from "@/lib/current-workspace.ts";
import { requireUser } from "@/lib/auth.ts";
import { AutomationInput, createAutomation, listAutomations } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

/** The workspace's automations, each with its last few runs. `?workspace=` picks the workspace. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ automations: await listAutomations(ctx, workspaceId) });
});

/** Create one. The schedule, agent and repository are checked now, not when it first runs. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  const input = await parseBody(request, AutomationInput);
  await enforce(ctx.db, `automations:${user.userId}`, { max: 60, windowSeconds: 3600 }, "automation changes");
  return json({ automation: await createAutomation(ctx, user.userId, workspaceId, input) }, 201);
});
