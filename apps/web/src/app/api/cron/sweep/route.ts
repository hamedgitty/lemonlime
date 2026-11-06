import { bearerToken, safeEqual } from "@/lib/access-tokens.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { sweepRunningSandboxes } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * Pause idle cloud sandboxes and any the usage policy no longer allows.
 * For Node deployments: call it every minute from any scheduler with
 * `Authorization: Bearer $LEMONLIME_CRON_SECRET`. On Cloudflare Workers the
 * Worker's cron trigger runs the same sweep directly (see worker.ts).
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !safeEqual(token, ctx.config.cronSecret())) throw new HttpError(401, "Bad cron secret.");
  return json(await sweepRunningSandboxes(ctx));
});
