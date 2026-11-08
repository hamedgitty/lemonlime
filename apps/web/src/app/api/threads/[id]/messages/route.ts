import { PendingMessage } from "@lemonlime/protocol";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { addPendingMessage } from "@/lib/history.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { enforce, LIMITS } from "@/lib/rate-limit.ts";
import { getThreadRowForUser, resumeThread, threadResponse } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

/**
 * Send a message to a cloud thread whose sandbox is paused: it is saved here first, then
 * the sandbox wakes and the runner picks it up. Sending the same `clientMsgId` again is
 * harmless. If the usage policy won't start the sandbox, the message stays saved and the
 * response says why.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const msg = await parseBody(request, PendingMessage);
  const row = await getThreadRowForUser(ctx, user.userId, (await params).id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads take messages through the desktop app.");
  if (row.status === "stopped" || !row.sandboxId) throw new HttpError(409, "This thread's sandbox no longer exists.");
  // People's messages never carry a check script; only automations set one.
  await addPendingMessage(ctx, row.id, { clientMsgId: msg.clientMsgId, text: msg.text });
  if (row.runningSince) return json({ queued: true, ...(await threadResponse(ctx, row, user.userId)) });
  await enforce(ctx.db, `sandbox-starts:${user.userId}`, LIMITS.sandboxStartsPerUser, "sandbox starts");
  return json({ queued: true, ...(await resumeThread(ctx, user.userId, row.id)) });
});
