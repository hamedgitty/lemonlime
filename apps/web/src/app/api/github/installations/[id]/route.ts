import { requestWorkspace } from "@/lib/current-workspace.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { unlinkInstallation } from "@/lib/github.ts";
import { json, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * Disconnect a GitHub installation from the workspace (uninstall the app on GitHub to
 * remove it there). Only the workspace's owners can.
 */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  await unlinkInstallation(ctx, user.userId, workspaceId, (await params).id);
  return json({ ok: true });
});
