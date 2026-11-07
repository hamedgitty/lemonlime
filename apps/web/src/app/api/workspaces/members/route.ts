import { z } from "zod";
import { requireUser } from "@/lib/auth.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { inviteMember, listMembers } from "@/lib/members.ts";
import { enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

const Invite = z.object({ email: z.email().max(320) });

/** People in the workspace and invitations still waiting. `?workspace=` picks the workspace. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ workspaceId, ...(await listMembers(ctx.db, workspaceId)) });
});

/** Invite someone by email (owners only). */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  const { email } = await parseBody(request, Invite);
  await enforce(ctx.db, `invites:${user.userId}`, { max: 30, windowSeconds: 3600 }, "invitations");
  return json({ invite: await inviteMember(ctx, { userId: user.userId, workspaceId, email }) });
});
