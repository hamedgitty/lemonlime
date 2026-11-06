import { bearerToken, safeEqual } from "@/lib/access-tokens.ts";
import { env } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { sweepRunningSandboxes } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * Pause idle cloud sandboxes and any the usage policy no longer allows.
 * Call it every minute from any scheduler with `Authorization: Bearer $LEMONLIME_CRON_SECRET`.
 */
export const POST = route(async request => {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !safeEqual(token, env.cronSecret())) throw new HttpError(401, "Bad cron secret.");
  return json(await sweepRunningSandboxes());
});
