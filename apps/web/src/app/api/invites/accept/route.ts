import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth.ts";
import { WORKSPACE_COOKIE, workspaceCookieOptions } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { parseBody, route } from "@/lib/http.ts";
import { acceptInvite } from "@/lib/members.ts";
import { enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

const Body = z.object({ token: z.string().min(1).max(200) });

/** Accept an invitation and switch the dashboard to that workspace. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const { token } = await parseBody(request, Body);
  await enforce(ctx.db, `invite-accept:${user.userId}`, { max: 20, windowSeconds: 3600 }, "invitation attempts");
  const workspaceId = await acceptInvite(ctx, { userId: user.userId, token });
  const res = NextResponse.json({ workspaceId });
  res.cookies.set(WORKSPACE_COOKIE, workspaceId, workspaceCookieOptions(ctx.production));
  return res;
});
