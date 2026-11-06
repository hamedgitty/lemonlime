import { revokeAccessToken } from "@/lib/access.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** Revoke one of the user's personal access tokens. */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Token not found.");
  if (!(await revokeAccessToken(ctx.db, user.userId, id))) throw new HttpError(404, "Token not found.");
  return json({ deleted: id });
});
