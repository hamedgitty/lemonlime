import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceMember } from "@/lib/access.ts";
import { requireUser } from "@/lib/auth.ts";
import { WORKSPACE_COOKIE, workspaceCookieOptions } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { parseBody, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

const Body = z.object({ workspaceId: z.string().min(1).max(100) });

/** Switch the dashboard to another of your workspaces. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const { workspaceId } = await parseBody(request, Body);
  await requireWorkspaceMember(ctx.db, user.userId, workspaceId);
  const res = NextResponse.json({ workspaceId });
  res.cookies.set(WORKSPACE_COOKIE, workspaceId, workspaceCookieOptions(ctx.production));
  return res;
});
