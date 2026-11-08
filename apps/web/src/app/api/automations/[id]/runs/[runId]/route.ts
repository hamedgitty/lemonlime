import { z } from "zod";
import { requireUser } from "@/lib/auth.ts";
import { setRunReviewed } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

const ReviewRun = z.object({ reviewed: z.boolean() });

/** Mark a run as looked at (`{ "reviewed": true }`) or not. Any member of the workspace. */
export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const { reviewed } = await parseBody(request, ReviewRun);
  const { id, runId } = await params;
  return json({ run: await setRunReviewed(ctx, user.userId, id, runId, reviewed) });
});
