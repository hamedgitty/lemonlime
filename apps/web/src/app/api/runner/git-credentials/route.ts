import { getAppContext } from "@/lib/env.ts";
import { tokenForThread } from "@/lib/github.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { getThreadRow } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/**
 * Runner ← control plane: a fresh, hour-long token for the thread's own GitHub
 * repository, asked for by git's credential helper whenever git needs one. `?threadId=`.
 * 404 when the repo isn't covered by the workspace's GitHub app (public repos still clone).
 */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  const auth = await authenticateRunner(request.headers.get("authorization"), threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  const row = await getThreadRow(ctx, threadId);
  if (!row || row.mode !== "cloud") throw new HttpError(404, "Thread not found.");
  const creds = await tokenForThread(ctx, row);
  if (!creds) throw new HttpError(404, "No GitHub access for this repository.");
  return json({ username: "x-access-token", password: creds.token, expiresAt: creds.expiresAt });
});
