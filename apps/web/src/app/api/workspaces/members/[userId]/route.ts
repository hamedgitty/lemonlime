import { requireUser } from "@/lib/auth.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { removeMember } from "@/lib/members.ts";

export const dynamic = "force-dynamic";

/** Remove someone from the workspace (owners), or leave it (your own id). */
export const DELETE = route<{ params: Promise<{ userId: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  await removeMember(ctx, { userId: user.userId, workspaceId, memberId: (await params).userId });
  return json({ ok: true });
});
