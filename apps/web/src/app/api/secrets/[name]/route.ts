import { requestWorkspace } from "@/lib/current-workspace.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { deleteSecret } from "@/lib/secrets.ts";

export const dynamic = "force-dynamic";

/** Remove a secret. Sandboxes that already have it keep it until they are deleted. */
export const DELETE = route<{ params: Promise<{ name: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  if (!(await deleteSecret(ctx, workspaceId, (await params).name))) throw new HttpError(404, "No secret with that name.");
  return json({ ok: true });
});
