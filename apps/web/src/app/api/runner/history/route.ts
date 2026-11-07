import { RunnerHistoryUpload } from "@lemonlime/protocol";
import { getAppContext } from "@/lib/env.ts";
import { appendHistory } from "@/lib/history.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { getLiveRunnerThread } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/** Runner → control plane: keep the next part of the thread's history. Auth: runner token. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const upload = await parseBody(request, RunnerHistoryUpload);
  const auth = await authenticateRunner(request.headers.get("authorization"), upload.threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  const row = await getLiveRunnerThread(ctx, upload.threadId);
  return json(await appendHistory(ctx, row, upload.events));
});
