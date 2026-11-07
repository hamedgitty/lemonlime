import { resolveWorkspace } from "@/lib/access.ts";
import { loginUrl, requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { installUrl, requireGitHub, signInstallState } from "@/lib/github.ts";
import { route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** Start installing the GitHub app for the signed-in user's workspace. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request).catch(() => null);
  if (!user) return Response.redirect(new URL(loginUrl("/settings"), request.url), 302);
  const cfg = requireGitHub(ctx);
  const workspaceId = await resolveWorkspace(ctx.db, user.userId, new URL(request.url).searchParams.get("workspace"));
  const state = await signInstallState(ctx.config.tokenSecret(), workspaceId, user.userId);
  return Response.redirect(installUrl(cfg, state), 302);
});
