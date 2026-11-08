import { RunnerInboxAck } from "@lemonlime/protocol";
import { recordCheckSkips } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { ackPendingMessages, listPendingMessages } from "@/lib/history.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { getLiveRunnerThread } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/** Runner ← control plane: messages sent while the sandbox was paused. `?threadId=`. Auth: runner token. */
export const GET = route(async request => {
  const ctx = await getAppContext();
  const threadId = new URL(request.url).searchParams.get("threadId") ?? "";
  const auth = await authenticateRunner(request.headers.get("authorization"), threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  await getLiveRunnerThread(ctx, threadId);
  return json({ messages: await listPendingMessages(ctx, threadId) });
});

/** Runner → control plane: these messages are in the runner's queue or history now. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const ack = await parseBody(request, RunnerInboxAck);
  const auth = await authenticateRunner(request.headers.get("authorization"), ack.threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  await getLiveRunnerThread(ctx, ack.threadId);
  await ackPendingMessages(ctx, ack.threadId, ack.clientMsgIds);
  // An automation's check script said there was nothing to do: record the run as skipped.
  if (ack.skipped?.length) await recordCheckSkips(ctx, ack.threadId, ack.skipped);
  return json({ ok: true });
});
