import { z } from "zod";
import { resolveWorkspace } from "@/lib/access.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { enforce } from "@/lib/rate-limit.ts";
import { listSecrets, setSecret } from "@/lib/secrets.ts";

export const dynamic = "force-dynamic";

const SetSecretRequest = z.object({ name: z.string().trim().min(1).max(64), value: z.string().min(1).max(40_000) });

/** Names of the workspace's secrets, never their values. `?workspace=` picks the workspace. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await resolveWorkspace(ctx.db, user.userId, new URL(request.url).searchParams.get("workspace"));
  return json({ secrets: await listSecrets(ctx, workspaceId) });
});

/** Add or replace a secret. It is encrypted at once; new cloud sandboxes get it as an environment variable. */
export const PUT = route(async request => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await resolveWorkspace(ctx.db, user.userId, new URL(request.url).searchParams.get("workspace"));
  const { name, value } = await parseBody(request, SetSecretRequest);
  await enforce(ctx.db, `secrets:${user.userId}`, { max: 60, windowSeconds: 3600 }, "secret changes");
  return json({ secret: await setSecret(ctx, user.userId, workspaceId, name, value) });
});
