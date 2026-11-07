import { requireWorkspaceMember } from "@/lib/access.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError } from "@/lib/errors.ts";
import { linkInstallation, requireGitHub, verifyInstallState } from "@/lib/github.ts";
import { route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * GitHub sends people back here after installing the app (the app's "Setup URL", with
 * "Request user authorization during installation" turned on). Links the installation
 * to the workspace that started it, after checking the person can really manage it.
 */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const back = (result: string) => Response.redirect(new URL(`/settings?github=${result}`, request.url), 302);
  const params = new URL(request.url).searchParams;
  const installationId = params.get("installation_id") ?? "";
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!/^\d{1,20}$/.test(installationId) || !code) return back("missing");
  const cfg = requireGitHub(ctx);
  const user = await requireUser(ctx, request);
  const claims = await verifyInstallState(ctx.config.tokenSecret(), state);
  if (!claims || claims.userId !== user.userId) return back("expired");
  await requireWorkspaceMember(ctx.db, user.userId, claims.workspaceId);
  try {
    await linkInstallation(ctx, cfg, { workspaceId: claims.workspaceId, userId: user.userId, installationId, code });
  } catch (err) {
    if (err instanceof HttpError) return back(err.status === 409 ? "taken" : "denied");
    throw err;
  }
  return back("connected");
});
