import { requireUser } from "@/lib/auth.ts";
import { removeWebhook, rotateWebhook } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Give the automation a webhook, or a new secret for it (the old URL stops working). The
 * URL is in the response this once; only a hash of its secret is kept.
 */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  await enforce(ctx.db, `automations:${user.userId}`, { max: 60, windowSeconds: 3600 }, "automation changes");
  const { path } = await rotateWebhook(ctx, user.userId, (await params).id);
  return json({ url: `${ctx.config.publicUrl()}${path}` });
});

/** Turn the webhook off. */
export const DELETE = route(async (request: Request, { params }: Ctx) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  await removeWebhook(ctx, user.userId, (await params).id);
  return json({ ok: true });
});
