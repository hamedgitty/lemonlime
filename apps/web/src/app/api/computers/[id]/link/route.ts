import { ComputerId } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { linkTicket } from "@/lib/computers.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, route } from "@/lib/http.ts";
import { bridgeControl } from "@/lib/phone-bridge.ts";
import { enforce, LIMITS } from "@/lib/rate-limit.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** For the desktop app: where to open its computer's link to the phone bridge, and a ticket for it. */
export const POST = route<Context>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const { id } = await params;
  if (!ComputerId.safeParse(id).success) throw new HttpError(404, "Computer not found.");
  await enforce(ctx.db, `phone-link:${user.userId}`, LIMITS.phoneLinks, "phone links");
  return json(await linkTicket(ctx, bridgeControl(ctx), user.userId, id));
});
