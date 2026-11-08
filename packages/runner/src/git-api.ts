import type { IncomingMessage, ServerResponse } from "node:http";
import { CreatePullRequestBody, DiffScope } from "@lemonlime/protocol";
import { ReviewError, type GitReview } from "./git-review.ts";

interface Helpers {
  reply: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage, max: number) => Promise<Buffer | null>;
}

/**
 * The thread's branch for review, with a client token (checked by the caller):
 * - `GET /git/status`: changed-file counts, commits, push state, compare page, whether `gh` works
 * - `GET /git/diff?scope=branch|uncommitted|commit&commit=<sha>&path=<file>&oldPath=<file>&context=<n>`
 * - `GET /git/pull-request`: the branch's pull request, when `gh` can tell
 * - `POST /git/push`: push the branch to origin (never forced)
 * - `POST /git/pull-request` {title?, body?, draft?}: push, then open one with `gh`, or
 *   answer with the compare page to open in the browser
 */
export async function handleGitApi(req: IncomingMessage, res: ServerResponse, path: string, review: GitReview | null, h: Helpers): Promise<void> {
  if (!review) return h.reply(res, 404, { error: "This thread has no git branch." });
  const q = new URL(req.url ?? "/", "http://runner").searchParams;
  try {
    if (path === "/git/status" && req.method === "GET") return h.reply(res, 200, await review.status());
    if (path === "/git/diff" && req.method === "GET") {
      const scope = DiffScope.safeParse(q.get("scope") ?? "branch");
      if (!scope.success) return h.reply(res, 400, { error: "scope is branch, uncommitted or commit" });
      const context = q.get("context");
      return h.reply(
        res,
        200,
        await review.diff({
          scope: scope.data,
          ...(q.get("commit") ? { commit: q.get("commit")! } : {}),
          ...(q.get("path") ? { path: q.get("path")! } : {}),
          ...(q.get("oldPath") ? { oldPath: q.get("oldPath")! } : {}),
          ...(context && /^\d+$/.test(context) ? { context: Number(context) } : {}),
        }),
      );
    }
    if (path === "/git/pull-request" && req.method === "GET") return h.reply(res, 200, await review.pullRequest());
    if (path === "/git/push" && req.method === "POST") {
      const problem = await review.push();
      return problem ? h.reply(res, 409, { error: problem }) : h.reply(res, 200, { ok: true });
    }
    if (path === "/git/pull-request" && req.method === "POST") {
      const raw = await h.readBody(req, 128 * 1024);
      let parsed: unknown = {};
      try {
        parsed = raw && raw.length ? JSON.parse(raw.toString()) : {};
      } catch {
        return h.reply(res, 400, { error: "bad json" });
      }
      const body = CreatePullRequestBody.safeParse(parsed);
      if (!body.success) return h.reply(res, 400, { error: "bad request" });
      return h.reply(res, 200, await review.createPullRequest(body.data));
    }
    return h.reply(res, 404, { error: "not_found" });
  } catch (err) {
    if (err instanceof ReviewError) return h.reply(res, err.status, { error: err.message });
    const message = err instanceof Error ? err.message : String(err);
    return h.reply(res, /^Not a usable|^Pick a commit|isn't in this repository/.test(message) ? 400 : 500, { error: message });
  }
}
