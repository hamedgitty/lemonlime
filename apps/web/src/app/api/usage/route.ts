import { requestWorkspace } from "@/lib/current-workspace.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { usageNotice, usageSummary } from "@/lib/usage.ts";

export const dynamic = "force-dynamic";

/** The deployment's usage banner and sidebar card for the workspace, if any (both null when self-hosting). */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  const [notice, summary] = await Promise.all([usageNotice(ctx, user.userId, workspaceId), usageSummary(ctx, user.userId, workspaceId)]);
  return json({ notice, summary });
});
