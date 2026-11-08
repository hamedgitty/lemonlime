import { PutWorkspaceSkillsRequest } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";
import { getWorkspaceSkills, putWorkspaceSkills } from "@/lib/workspace-settings.ts";

export const dynamic = "force-dynamic";

/** The workspace's own skills, with their files (any member). */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ workspaceId, skills: await getWorkspaceSkills(ctx, user.userId, workspaceId) });
});

/**
 * Replace the list (owners only), e.g. the skills the desktop app has. Every new sandbox
 * in the workspace gets them in its user skills folder.
 */
export const PUT = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  const { skills } = await parseBody(request, PutWorkspaceSkillsRequest);
  await enforce(ctx.db, `workspace-skills:${user.userId}`, { max: 120, windowSeconds: 3600 }, "skill uploads");
  return json({ ok: true as const, ...(await putWorkspaceSkills(ctx, user.userId, workspaceId, skills)) });
});
