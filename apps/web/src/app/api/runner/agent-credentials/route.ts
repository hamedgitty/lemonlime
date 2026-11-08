import { AgentCredentialUpload } from "@lemonlime/protocol";
import { saveAgentCredential } from "@/lib/agent-credentials.ts";
import { getAppContext } from "@/lib/env.ts";
import { HttpError, json, parseBody, route } from "@/lib/http.ts";
import { getLiveRunnerThread } from "@/lib/threads.ts";
import { authenticateRunner } from "@/lib/tokens.ts";
import { signInRequestedRecently } from "@/lib/agent-credentials.ts";

export const dynamic = "force-dynamic";

/**
 * Runner → control plane: the user signed the agent in inside this sandbox; keep the
 * result (encrypted) so their next sandboxes start signed in. Auth: runner token, and a
 * member must have asked for the sign-in (POST /api/threads/:id/sign-in) shortly before.
 */
export const POST = route(async request => {
  const ctx = await getAppContext();
  const upload = await parseBody(request, AgentCredentialUpload);
  const auth = await authenticateRunner(request.headers.get("authorization"), upload.threadId, ctx.config.tokenSecret());
  if (!auth.ok) throw new HttpError(auth.status, auth.error);
  const row = await getLiveRunnerThread(ctx, upload.threadId);
  if (!row.createdBy) throw new HttpError(404, "Thread not found.");
  if (row.agent.kind !== upload.agent) throw new HttpError(400, "That credential is for a different agent.");
  // Only soon after a member asked to sign the agent in: anything else in the sandbox that
  // holds a runner token can't swap the user's saved login for its own.
  if (!signInRequestedRecently(row.signInRequestedAt)) throw new HttpError(403, "No sign-in was asked for in this thread just now.");
  await saveAgentCredential(ctx, row.createdBy, upload);
  return json({ ok: true });
});
