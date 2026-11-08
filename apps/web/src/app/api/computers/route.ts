import { requireUser } from "@/lib/auth.ts";
import { listComputerThreads } from "@/lib/computers.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { bridgeControl } from "@/lib/phone-bridge.ts";

export const dynamic = "force-dynamic";

/** Your computers with phone access on, in a workspace, and the threads each shares. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ available: bridgeControl(ctx) !== null, computers: await listComputerThreads(ctx, user.userId, workspaceId) });
});
