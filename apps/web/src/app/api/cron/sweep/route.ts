import { bearerToken, safeEqual } from "@/lib/access-tokens.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { closeInactiveThreads, sweepRunningSandboxes } from "@/lib/threads.ts";
import { runDueAutomations } from "@/lib/automations.ts";
import { runPluginSchedule } from "@/lib/plugin-schedule.ts";
import { relayEnabled, relayRunnerCalls } from "@/lib/relay.ts";
import { dispatchRunnerCall } from "@/lib/relay-routes.ts";

export const dynamic = "force-dynamic";

/**
 * Pause idle cloud sandboxes and any the usage policy no longer allows, start any
 * automations that are due, and give the deployment plugin its periodic turn.
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
  await runPluginSchedule(ctx);
  return json({ ...sweep, automations, autoDelete, ...(relay ? { relay } : {}) });
});
