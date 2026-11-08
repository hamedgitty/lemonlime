import { requestWorkspace } from "@/lib/current-workspace.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { githubAppConfig, listInstallations } from "@/lib/github.ts";
import { json, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** The GitHub accounts connected to the workspace, and whether this server has a GitHub App at all. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  const configured = githubAppConfig(ctx.vars) !== null;
  return json({ configured, installations: configured ? await listInstallations(ctx, workspaceId) : [] });
});
