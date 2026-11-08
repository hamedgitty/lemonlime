import { bearerToken, safeEqual } from "@/lib/access-tokens.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { closeInactiveThreads, sweepRunningSandboxes } from "@/lib/threads.ts";
import { runDueAutomations } from "@/lib/automations.ts";
import { relayEnabled, relayRunnerCalls } from "@/lib/relay.ts";
import { dispatchRunnerCall } from "@/lib/relay-routes.ts";

export const dynamic = "force-dynamic";

/**
 * Pause idle cloud sandboxes and any the usage policy no longer allows, then start any
 * automations that are due.
 * For Node deployments: call it every minute from any scheduler with
 * `Authorization: Bearer $LEMONLIME_CRON_SECRET`. On Cloudflare Workers the
 * Worker's cron trigger runs the same sweep directly (see worker.ts).
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !safeEqual(token, ctx.config.cronSecret())) throw new HttpError(401, "Bad cron secret.");
  // Relayed heartbeats first, so the sweep decides on fresh news.
  const relay = relayEnabled(ctx.vars) ? await relayRunnerCalls(ctx, dispatchRunnerCall) : null;
  const sweep = await sweepRunningSandboxes(ctx);
  const automations = await runDueAutomations(ctx);
  // Threads idle longer than their workspace keeps them: closed, sandboxes deleted.
  const autoDelete = await closeInactiveThreads(ctx);
  return json({ ...sweep, automations, autoDelete, ...(relay ? { relay } : {}) });
});
