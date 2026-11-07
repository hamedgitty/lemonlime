import { AgentCredentialUpload } from "@lemonlime/protocol";
import { saveAgentCredential } from "@/lib/agent-credentials.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { getThreadRow } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";

export const dynamic = "force-dynamic";

/**
 * Runner → control plane: the user signed the agent in inside this sandbox; keep the
 * result (encrypted) so their next sandboxes start signed in. Auth: runner token.
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const upload = await parseBody(request, AgentCredentialUpload);
  const auth = await authenticateRunner(request.headers.get("authorization"), upload.threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  const row = await getThreadRow(ctx, upload.threadId);
  if (!row || row.mode !== "cloud" || !row.createdBy) throw new HttpError(404, "Thread not found.");
  if (row.agent.kind !== upload.agent) throw new HttpError(400, "That credential is for a different agent.");
  await saveAgentCredential(ctx, row.createdBy, upload);
  return json({ ok: true });
});
