import { z } from "zod";

/**
 * Reviewing a thread's git branch over the runner's HTTP API (client token):
 * `GET /git/status`, `GET /git/diff`, `GET /git/pull-request`, `POST /git/push` and
 * `POST /git/pull-request`. Diffs come from git itself, not from the agent's events.
 */

/** Which changes a diff shows. */
export const DiffScope = z.enum([
  /** Everything on the branch since it left the base branch, including uncommitted work. */
  "branch",
  /** Only what isn't committed yet. */
  "uncommitted",
  /** One commit (pass `commit`). */
  "commit",
]);
export type DiffScope = z.infer<typeof DiffScope>;

export const DiffHunk = z.object({
  /** The `@@ -a,b +c,d @@ section` line. */
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Lines with their first character: " " context, "+" added, "-" removed, "\\" a note. */
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const ReviewFileStatus = z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed"]);
export type ReviewFileStatus = z.infer<typeof ReviewFileStatus>;

export const ReviewFile = z.object({
  path: z.string(),
  /** The path before a rename or copy. */
  oldPath: z.string().optional(),
  status: ReviewFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  hunks: z.array(DiffHunk),
  /** Hunks were cut short (or left out) because the file's diff is too large. */
  truncated: z.boolean(),
});
export type ReviewFile = z.infer<typeof ReviewFile>;

export const BranchCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO date. */
  date: z.string(),
});
export type BranchCommit = z.infer<typeof BranchCommit>;

export const GitDiffResponse = z.object({
  scope: DiffScope,
  /** The commit shown (scope `commit`). */
  commit: z.string().optional(),
  /** What the diff is against: the merge base, HEAD, or the commit's parent. */
  base: z.string(),
  files: z.array(ReviewFile),
  /** More files changed than were listed. */
  moreFiles: z.number().int().nonnegative().default(0),
  /** The branch's own commits, newest first, for the commit picker. */
  commits: z.array(BranchCommit),
});
export type GitDiffResponse = z.infer<typeof GitDiffResponse>;

export const PullRequestInfo = z.object({
  url: z.string(),
  number: z.number().int().optional(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean().default(false),
  /** Checks on the latest commit, when `gh` can tell. */
  checks: z.enum(["passing", "failing", "pending", "none"]).optional(),
});
export type PullRequestInfo = z.infer<typeof PullRequestInfo>;

export const GitStatusResponse = z.object({
  branch: z.string(),
  baseBranch: z.string(),
  /** Files changed and not committed yet. */
  uncommittedFiles: z.number().int().nonnegative(),
  /** Files changed by the branch's commits since the base branch. */
  committedFiles: z.number().int().nonnegative(),
  /** The branch's own commits. */
  commits: z.number().int().nonnegative(),
  /** Commits not on the remote branch yet (all of them when it was never pushed). */
  unpushed: z.number().int().nonnegative(),
  hasRemote: z.boolean(),
  /** Pushed at least once. */
  pushed: z.boolean(),
  /** A web page that compares the branch with the base branch, when the remote is on GitHub. */
  compareUrl: z.string().nullable(),
  /** Whether the GitHub CLI can open pull requests from here. */
  gh: z.enum(["ready", "signed_out", "missing"]),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponse>;

export const GitPullRequestResponse = z.object({
  pullRequest: PullRequestInfo.nullable(),
  /** No `gh` here: open this page in the browser instead (null if the remote isn't on GitHub). */
  compareUrl: z.string().nullable().optional(),
});
export type GitPullRequestResponse = z.infer<typeof GitPullRequestResponse>;

export const CreatePullRequestBody = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(60_000).optional(),
  draft: z.boolean().optional(),
});
export type CreatePullRequestBody = z.infer<typeof CreatePullRequestBody>;

/**
 * `owner/repo` web address on GitHub from a git remote URL (https, ssh or scp-style),
 * without any credentials it carries. Null for anything that isn't GitHub-shaped.
 */
export function githubRepoWebUrl(remote: string): string | null {
  const url = remote.trim();
  let host = "";
  let path = "";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (/^(https?|ssh|git):\/\//i.test(url)) {
    try {
      const u = new URL(url);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else return null;
  // GitHub and GitHub Enterprise hosts; other forges use different compare pages.
  if (!/(^|\.)github(\.|$)/i.test(host)) return null;
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2 || parts.some(p => !/^[\w.-]+$/.test(p))) return null;
  return `https://${host.toLowerCase()}/${parts[0]}/${parts[1]}`;
}

/** GitHub's page for opening a pull request from `branch` into `base`, or null. */
export function compareUrlFor(remote: string, base: string, branch: string): string | null {
  const web = githubRepoWebUrl(remote);
  if (!web || !base || !branch) return null;
  const enc = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
  return `${web}/compare/${enc(base)}...${enc(branch)}?expand=1`;
}
