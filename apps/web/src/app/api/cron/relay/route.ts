import { bearerToken, safeEqual } from "@/lib/access-tokens.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { relayEnabled, relayRunnerCalls } from "@/lib/relay.ts";
import { dispatchRunnerCall } from "@/lib/relay-routes.ts";

export const dynamic = "force-dynamic";

/**
 * Relay mode (LEMONLIME_RUNNER_RELAY=true): collect the calls runners kept because their
 * sandbox can't reach us, make them, and hand back the answers. Run every minute with
 * `Authorization: Bearer $LEMONLIME_CRON_SECRET`, before the sweep; on Cloudflare Workers
 * the cron trigger does it (see worker.ts), and POST /api/cron/sweep does it on Node.
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !safeEqual(token, ctx.config.cronSecret())) throw new HttpError(401, "Bad cron secret.");
  if (!relayEnabled(ctx.vars)) return json({ threads: 0, calls: 0, errors: [], enabled: false });
  return json(await relayRunnerCalls(ctx, dispatchRunnerCall));
});
