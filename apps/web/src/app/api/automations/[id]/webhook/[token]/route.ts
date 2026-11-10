import { readWebhookBody, triggerWebhook, WEBHOOK_LIMITS } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { callerAddress, enforce } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; token: string }> };

/**
 * Start a run of an automation from outside (CI, an alert, another service). No sign-in:
 * the secret in the URL is the key. An optional body (JSON, up to 16 KB) is passed to the
 * agent as context, marked as untrusted input. Answers 202 once the run is recorded.
 */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const ctx = await getAppContext();
  const { id, token } = await params;
  await enforce(ctx.db, `automation-hook-ip:${callerAddress(ctx, request)}`, WEBHOOK_LIMITS.perAddress, "webhook calls");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^[A-Za-z0-9_-]{1,100}$/.test(token)) throw new HttpError(404, "No webhook here.");
  const run = await triggerWebhook(ctx, id, token, await readWebhookBody(request));
  return json({ ok: run.status === "started", status: run.status, ...(run.threadId ? { threadId: run.threadId } : {}) }, run.status === "started" ? 202 : 200);
});
