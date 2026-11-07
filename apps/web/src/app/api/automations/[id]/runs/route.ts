import { requireUser } from "@/lib/auth.ts";
import { listAutomationRuns } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** An automation's run history, newest first. */
export const GET = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  return json({ runs: await listAutomationRuns(ctx, user.userId, (await params).id) });
});
