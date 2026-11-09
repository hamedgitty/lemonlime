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
  /** Commits on the base branch that this branch doesn't have yet. Older runners leave it out. */
  behind: z.number().int().nonnegative().default(0),
  hasRemote: z.boolean(),
  /** Pushed at least once. */
  pushed: z.boolean(),
  /** A web page that compares the branch with the base branch, when the remote is on GitHub. */
  compareUrl: z.string().nullable(),
  /** Whether the GitHub CLI can open pull requests from here. */
  gh: z.enum(["ready", "signed_out", "missing"]),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponse>;

/** Watching a pull request: the agent is woken when its checks fail, it gets comments or it can't merge. */
export const PullRequestWatchState = z.object({
  on: z.boolean(),
  /** Times the agent was woken by new comments alone (they stop counting at the limit). */
  commentWakes: z.number().int().nonnegative().default(0),
  /** Most times new comments alone wake the agent, so a bot can't keep it going forever. */
  maxCommentWakes: z.number().int().positive(),
});
export type PullRequestWatchState = z.infer<typeof PullRequestWatchState>;

export const WatchPullRequestBody = z.object({ on: z.boolean() });
export type WatchPullRequestBody = z.infer<typeof WatchPullRequestBody>;

export const GitPullRequestResponse = z.object({
  pullRequest: PullRequestInfo.nullable(),
  /** No `gh` here: open this page in the browser instead (null if the remote isn't on GitHub). */
  compareUrl: z.string().nullable().optional(),
  /** Whether the pull request is being watched (runners that can watch one). */
  watch: PullRequestWatchState.optional(),
  /** The agent can't push to the pull request's branch (a fork that doesn't allow edits), in plain words. */
  pushProblem: z.string().optional(),
});
export type GitPullRequestResponse = z.infer<typeof GitPullRequestResponse>;

/** `GET /git/pull-request/draft`: a title and description written from the thread's commits, to edit before opening. */
export const PullRequestDraft = z.object({ title: z.string(), body: z.string() });
export type PullRequestDraft = z.infer<typeof PullRequestDraft>;

/** `POST /git/update-from-base`: bring the base branch's new commits into the thread's branch. */
export const UpdateFromBaseResponse = z.object({
  /** merged: a merge commit was made; up_to_date: nothing to bring in; conflicts: nothing changed (the merge was undone). */
  result: z.enum(["merged", "up_to_date", "conflicts"]),
  /** The files that conflicted (result `conflicts`). */
  conflicts: z.array(z.string()).default([]),
  /** The base branch it merged, as git named it (e.g. origin/main). */
  base: z.string(),
});
export type UpdateFromBaseResponse = z.infer<typeof UpdateFromBaseResponse>;

/** One branch for the branch picker. */
export const BranchInfo = z.object({
  name: z.string(),
  /** Only on the remote (`origin`) so far; working on it makes the local branch. */
  remote: z.boolean(),
  /** The folder it's checked out in, if any (a thread can't work on it then). */
  checkedOutAt: z.string().nullable(),
  /** ISO date of its latest commit. */
  date: z.string(),
});
export type BranchInfo = z.infer<typeof BranchInfo>;

/** `lemonlime-runner git branches`: the repository's branches, most recently changed first. */
export const BranchList = z.object({
  /** The branch checked out in the project folder, or null when it's detached. */
  current: z.string().nullable(),
  branches: z.array(BranchInfo),
});
export type BranchList = z.infer<typeof BranchList>;

/** `lemonlime-runner git pull-request`: a pull request found from a link or `#123`, to start a thread on. */
export const PullRequestLookup = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  baseBranch: z.string(),
  /** The pull request's branch, as named in the repository it comes from. */
  headBranch: z.string(),
  /** `owner/repo` of the repository the branch is in. */
  headRepo: z.string().nullable(),
  /** The branch is in a fork, not in this repository. */
  fromFork: z.boolean(),
  /** The branch name the thread works on here. */
  localBranch: z.string(),
  /** Why the agent's commits can't be pushed to the pull request, in plain words; null when they can. */
  pushProblem: z.string().nullable(),
});
export type PullRequestLookup = z.infer<typeof PullRequestLookup>;

/**
 * A pull request reference typed or pasted by the user: a GitHub pull request link, or
 * `#123`. Null for anything else (a sentence that merely mentions a number isn't one).
 */
export function parsePullRequestRef(text: string): { number: number; url?: string } | null {
  const t = text.trim();
  const short = /^#(\d{1,9})$/.exec(t);
  if (short) return Number(short[1]) > 0 ? { number: Number(short[1]) } : null;
  const link = /^https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/(\d{1,9})(?:[/?#][^\s]*)?$/i.exec(t);
  if (link && /(^|\.)github(\.|$)/i.test(new URL(t).hostname))
    return { number: Number(link[1]), url: t.replace(/[?#].*$/, "").replace(/\/(files|commits|checks)\/?$/, "") };
  return null;
}

/** The branch a thread works on for a pull request: its own name, or (from a fork) one that can't clash with ours. */
export function pullRequestLocalBranch(pr: { number: number; headBranch: string; fromFork: boolean }): string {
  if (!pr.fromFork) return pr.headBranch;
  const tail =
    pr.headBranch
      .replace(/[^\w./-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[-./]+|[-./]+$/g, "") || "branch";
  return `pr/${pr.number}-${tail}`.slice(0, 200);
}

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
