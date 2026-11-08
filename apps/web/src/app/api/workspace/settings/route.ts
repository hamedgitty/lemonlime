import { PutWorkspaceSettingsRequest } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";
import { getWorkspaceSettings, updateWorkspaceSettings } from "@/lib/workspace-settings.ts";

export const dynamic = "force-dynamic";

/** The workspace's cloud settings (any member). `?workspace=` picks the workspace. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json(await getWorkspaceSettings(ctx, user.userId, workspaceId));
});

/** Change some of them (owners only); fields left out stay as they are. New sandboxes use them. */
export const PUT = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  const patch = await parseBody(request, PutWorkspaceSettingsRequest);
  await enforce(ctx.db, `workspace-settings:${user.userId}`, { max: 120, windowSeconds: 3600 }, "settings changes");
  return json(await updateWorkspaceSettings(ctx, user.userId, workspaceId, patch));
});
