import { ComputerId, ComputerUpdate } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { forgetComputer, saveComputer } from "@/lib/computers.ts";
import { requestWorkspace } from "@/lib/current-workspace.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { bridgeControl } from "@/lib/phone-bridge.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function computerId(params: Context["params"]): Promise<string> {
  const { id } = await params;
  if (!ComputerId.safeParse(id).success) throw new HttpError(404, "Computer not found.");
  return id;
}

/**
 * The desktop app registers its computer and turns phone access on or off (with the
 * threads it shares while on). Turning it off cuts every phone connection at once.
 */
export const PUT = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const id = await computerId(params);
  const body = await parseBody(request, ComputerUpdate);
  const workspaceId = await requestWorkspace(ctx.db, user.userId, request);
  return json({ computer: await saveComputer(ctx, bridgeControl(ctx), user.userId, workspaceId, id, body) });
});

/** Forget this computer (the desktop app signed out). */
export const DELETE = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  await forgetComputer(ctx, bridgeControl(ctx), user.userId, await computerId(params));
  return json({ ok: true });
});
