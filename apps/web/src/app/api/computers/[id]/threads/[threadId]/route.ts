import { ComputerId, ThreadId } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { computerThreadResponse } from "@/lib/computers.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { bridgeControl } from "@/lib/phone-bridge.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; threadId: string }> };

/**
 * A thread on one of your computers, with a fresh bridge endpoint (the address and a phone
 * ticket) while the computer is online. Only for the computer's owner.
 */
export const GET = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const { id, threadId } = await params;
  if (!ComputerId.safeParse(id).success || !ThreadId.safeParse(threadId).success) throw new HttpError(404, "Thread not found.");
  return json(await computerThreadResponse(ctx, bridgeControl(ctx), user.userId, id, threadId));
});
