import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaces } from "@lemonlime/db";
import { deleteWorkspace } from "@/lib/account.ts";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, requireSameSite, route } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

const DeleteBody = z.object({ confirm: z.string().max(200) });

/**
 * Delete a team workspace with all its threads, sandboxes, history, secrets and automations.
 * Owners only, from a signed-in browser, with the workspace's name typed to confirm.
 */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  if (user.via !== "session") throw new HttpError(403, "Delete a workspace from the dashboard.");
  requireSameSite(request);
  const id = (await params).id;
  const { confirm } = await parseBody(request, DeleteBody);
  const [ws] = await ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, id));
  if (ws && confirm.trim() !== ws.name) throw new HttpError(400, "Type the workspace's name to confirm.");
  await deleteWorkspace(ctx, user.userId, id);
  return json({ ok: true });
});
