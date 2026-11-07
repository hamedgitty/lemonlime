import { resolveWorkspace } from "@/lib/access.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { usageNotice } from "@/lib/usage.ts";

export const dynamic = "force-dynamic";

/** The deployment's usage banner for the workspace, if any (`{ notice: null }` when self-hosting). */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await resolveWorkspace(ctx.db, user.userId, new URL(request.url).searchParams.get("workspace"));
  return json({ notice: await usageNotice(ctx, user.userId, workspaceId) });
});
