import { requireUser } from "@/lib/auth.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { revokeInvite } from "@/lib/members.ts";

export const dynamic = "force-dynamic";

/** Withdraw an invitation that hasn't been accepted (owners only). */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  if (!(await revokeInvite(ctx, { userId: user.userId, workspaceId, inviteId: (await params).id })))
    throw new HttpError(404, "No waiting invitation with that id.");
  return json({ ok: true });
});
