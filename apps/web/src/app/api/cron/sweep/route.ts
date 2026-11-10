import { bearerToken, safeEqual } from "@/lib/access-tokens.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { closeInactiveThreads, retryLeftoverSandboxes, sweepRunningSandboxes } from "@/lib/threads.ts";
import { runDueAutomations } from "@/lib/automations.ts";
import { runPluginSchedule } from "@/lib/plugin-schedule.ts";
import { pruneOldRecords } from "@/lib/retention.ts";
import { relayEnabled, relayRunnerCalls } from "@/lib/relay.ts";
import { dispatchRunnerCall } from "@/lib/relay-routes.ts";
import { runSteps } from "@/lib/sweep.ts";

export const dynamic = "force-dynamic";

/**
 * Pause idle cloud sandboxes and any the usage policy no longer allows, start any
 * automations that are due, and give the deployment plugin its periodic turn.
 * For Node deployments: call it every minute from any scheduler with
 * `Authorization: Bearer $LEMONLIME_CRON_SECRET`. On Cloudflare Workers the
 * Worker's cron trigger runs the same sweep directly (see worker.ts).
 *
 * Each job runs even if an earlier one failed. If any did, the answer is a 500 that names
 * them in `failed`, next to the results of the jobs that worked.
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !safeEqual(token, ctx.config.cronSecret())) throw new HttpError(401, "Bad cron secret.");
  const { results, failed } = await runSteps({
    // Relayed heartbeats first, so the sweep decides on fresh news.
    relay: async () => (relayEnabled(ctx.vars) ? relayRunnerCalls(ctx, dispatchRunnerCall) : null),
    sandboxes: () => sweepRunningSandboxes(ctx),
    // Sandboxes the provider failed to pause or remove when asked: ask again.
    leftovers: () => retryLeftoverSandboxes(ctx),
    automations: () => runDueAutomations(ctx),
    // Threads idle longer than their workspace keeps them: closed, sandboxes deleted.
    autoDelete: () => closeInactiveThreads(ctx),
    plugin: () => runPluginSchedule(ctx),
    // Expired sessions, sign-in codes, rate-limit counters and old invitations.
    pruned: () => pruneOldRecords(ctx),
  });
  const { relay, sandboxes, leftovers, automations, autoDelete, pruned } = results;
  return json(
    { ...sandboxes, leftovers, automations, autoDelete, pruned, ...(relay ? { relay } : {}), ...(failed.length ? { failed } : {}) },
    failed.length ? 500 : 200,
  );
});
