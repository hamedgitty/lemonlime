import { requireUser } from "@/lib/auth.ts";
import { AutomationPatch, deleteAutomation, updateAutomation } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Change an automation (any of its fields), e.g. `{ "enabled": false }` to pause it. */
export const PATCH = route(async (request: Request, { params }: Ctx) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const patch = await parseBody(request, AutomationPatch);
  return json({ automation: await updateAutomation(ctx, user.userId, (await params).id, patch) });
});

export const DELETE = route(async (request: Request, { params }: Ctx) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  await deleteAutomation(ctx, user.userId, (await params).id);
  return json({ ok: true });
});
