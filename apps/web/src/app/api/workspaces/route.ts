import { requireUser } from "@/lib/auth.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { listWorkspaces } from "@/lib/members.ts";

export const dynamic = "force-dynamic";

/** The workspaces you belong to, and which one the dashboard is showing. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json({ workspaces: await listWorkspaces(ctx.db, user.userId), current: await requestWorkspace(ctx.db, user.userId, request) });
});
