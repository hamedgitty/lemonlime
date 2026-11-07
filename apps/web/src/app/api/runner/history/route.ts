import { RunnerHistoryUpload } from "@lemonlime/protocol";
import { getAppContext } from "@/lib/env.ts";
import { appendHistory } from "@/lib/history.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { getThreadRow } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/** Runner → control plane: keep the next part of the thread's history. Auth: runner token. */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const upload = await parseBody(request, RunnerHistoryUpload);
  const auth = await authenticateRunner(request.headers.get("authorization"), upload.threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  const row = await getThreadRow(ctx, upload.threadId);
  if (!row) throw new HttpError(404, "Thread not found.");
  return json(await appendHistory(ctx, row, upload.events));
});
