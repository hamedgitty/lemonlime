import { PendingMessage } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { queueMessage } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * Send a message to a cloud thread whose sandbox is paused: it is saved here first, then
 * the sandbox wakes and the runner picks it up. Sending the same `clientMsgId` again is
 * harmless. If the usage policy won't start the sandbox, the message stays saved and the
 * response says why. Sending too fast, or to a thread with too many messages already
 * waiting, gets a 429 and saves nothing.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const msg = await parseBody(request, PendingMessage);
  return json({ queued: true, ...(await queueMessage(ctx, user.userId, (await params).id, msg)) });
});
