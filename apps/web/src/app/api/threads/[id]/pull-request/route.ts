import { z } from "zod";
import { requireUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { openPullRequest } from "@/lib/github.ts";
import { json, parseBody, route } from "@/lib/http.ts";
import { getThreadRowToTakePart } from "@/lib/threads.ts";

export const dynamic = "force-dynamic";

const PullRequestBody = z.object({ title: z.string().max(200).optional(), body: z.string().max(60_000).optional() }).default({});

/** Open a pull request for the thread's branch (or return the one already open). For those who may take part in the thread. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (request, { params }) => {
  const ctx = await getAppContext();
  const user = await requireUser(ctx, request);
  const row = await getThreadRowToTakePart(ctx, user.userId, (await params).id);
  const opts = request.headers.get("content-length") === "0" ? {} : await parseBody(request, PullRequestBody).catch(() => ({}));
  return json(await openPullRequest(ctx, row, opts));
});
