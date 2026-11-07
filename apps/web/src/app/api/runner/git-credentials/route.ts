import { getAppContext } from "@/lib/env.ts";
import { githubAppConfig, tokenForThread } from "@/lib/github.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { getLiveRunnerThread } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/**
 * Runner ← control plane: a fresh, hour-long token for the thread's own GitHub
 * repository, asked for by git's credential helper whenever git needs one.
 * `?threadId=&host=`: host is the one git wants to send it to (a submodule or remote
 * pointing elsewhere must never get the token).
 * 404 when the repo isn't covered by the workspace's GitHub app (public repos still clone).
 */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const params = new URL(request.url).searchParams;
  const threadId = params.get("threadId") ?? "";
  const auth = await authenticateRunner(request.headers.get("authorization"), threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  const row = await getLiveRunnerThread(ctx, threadId);
  const cfg = githubAppConfig(ctx.vars);
  if (!cfg || (params.get("host") ?? "").toLowerCase() !== new URL(cfg.webUrl).host.toLowerCase()) {
    throw new HttpError(404, "No GitHub access for that host.");
  }
  const creds = await tokenForThread(ctx, row);
  if (!creds) throw new HttpError(404, "No GitHub access for this repository.");
  return json({ username: "x-access-token", password: creds.token, expiresAt: creds.expiresAt });
});
