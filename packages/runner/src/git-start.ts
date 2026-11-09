import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { githubRepoWebUrl, parsePullRequestRef, pullRequestLocalBranch, type BranchInfo, type BranchList, type PullRequestLookup } from "@lemonlime/protocol";
import { assertSafeRef, gitError, GitWorkspace, type PushTarget } from "./git.ts";
import type { GhRunner } from "./git-review.ts";

/**
 * Where a new thread starts, before it has a worktree: the repository's branches for the
 * branch picker, and pull requests found from a link or `#123`, checked out so the agent
 * can push fixes to them. The user's own checkout is never switched.
 */

const run = promisify(execFile);
const MAX_BRANCHES = 1_000;

/** The repository's local branches and origin's, newest first; origin's only where there's no local one. */
export async function listBranches(repo: string): Promise<BranchList> {
  const ws = new GitWorkspace(repo);
  if (!(await ws.commonDir())) throw new Error(`${repo} is not a git repository`);
  const current = (await ws.git(["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })).trim() || null;
  const out = await ws.git(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(committerdate:iso-strict)%1f%(worktreepath)%1e", "refs/heads", "refs/remotes/origin"],
    { allowFail: true },
  );
  const local: BranchInfo[] = [];
  const remote: BranchInfo[] = [];
  for (const row of out.split("\x1e")) {
    const [ref = "", date = "", path = ""] = row.trim().split("\x1f");
    if (ref.startsWith("refs/heads/")) local.push({ name: ref.slice("refs/heads/".length), remote: false, checkedOutAt: path || null, date });
    else if (ref.startsWith("refs/remotes/origin/") && ref !== "refs/remotes/origin/HEAD")
      remote.push({ name: ref.slice("refs/remotes/origin/".length), remote: true, checkedOutAt: null, date });
  }
  const names = new Set(local.map(b => b.name));
  const branches = [...local, ...remote.filter(b => !names.has(b.name))].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { current, branches: branches.slice(0, MAX_BRANCHES) };
}

/** The GitHub CLI, run in `cwd`; replaceable in tests. */
export const runGh: GhRunner = async (args, cwd) => {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
  let last: unknown;
  for (const bin of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try {
      const { stdout } = await run(bin, args, { cwd, env, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      last = err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw last;
};

const PR_FIELDS = "number,title,url,state,isDraft,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify";

/** Find a pull request of this repository from a link or `#123`, with `gh`. */
export async function lookupPullRequest(repo: string, text: string, gh: GhRunner = runGh): Promise<PullRequestLookup> {
  const ref = parsePullRequestRef(text);
  if (!ref) throw new Error("That isn't a pull request link or number. Paste a link to it, or type # and its number.");
  const ws = new GitWorkspace(repo);
  const origin = await originUrl(ws);
  const home = origin ? githubRepoWebUrl(origin) : null;
  if (!home) throw new Error("This project's origin isn't on GitHub, so its pull requests can't be looked up.");
  if (ref.url && !ref.url.toLowerCase().startsWith(`${home.toLowerCase()}/pull/`)) {
    throw new Error(`That pull request is in another repository. This project's is ${home.replace(/^https:\/\/[^/]+\//, "")}.`);
  }
  let raw: string;
  try {
    raw = await gh(["pr", "view", String(ref.number), "--repo", home, "--json", PR_FIELDS], repo);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Finding pull requests needs the GitHub CLI (gh). Install it, then sign in with gh auth login.");
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message).trim();
    if (/auth login|not logged/i.test(msg)) throw new Error("Sign the GitHub CLI in (gh auth login) to find pull requests.");
    if (/could not resolve|not found|no pull requests/i.test(msg)) throw new Error(`There's no pull request #${ref.number} in this repository.`);
    throw new Error(`GitHub couldn't find that pull request: ${msg.split("\n").slice(-1)[0]}`);
  }
  const lookup = parsePullRequestLookup(JSON.parse(raw));
  if (!lookup) throw new Error("GitHub's answer about that pull request couldn't be read.");
  return lookup;
}

/** `gh pr view --json <PR_FIELDS>` → a lookup. Null when it isn't one. */
export function parsePullRequestLookup(json: unknown): PullRequestLookup | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.number !== "number" || typeof o.url !== "string" || typeof o.headRefName !== "string" || !o.headRefName) return null;
  const state = String(o.state ?? "").toUpperCase() === "MERGED" ? "merged" : String(o.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open";
  const owner = (o.headRepositoryOwner as { login?: unknown } | null)?.login;
  const name = (o.headRepository as { name?: unknown } | null)?.name;
  const headRepo = typeof owner === "string" && typeof name === "string" ? `${owner}/${name}` : null;
  const fromFork = o.isCrossRepository === true;
  const pushProblem = !fromFork
    ? null
    : !headRepo
      ? "This pull request's fork was deleted, so the agent can work on it here but can't push to it."
      : o.maintainerCanModify === true
        ? null
        : "This pull request comes from a fork that doesn't allow edits from maintainers, so the agent can work on it here but can't push its commits to it.";
  const base = { number: o.number, headBranch: o.headRefName, fromFork };
  return {
    number: o.number,
    title: String(o.title ?? ""),
    url: o.url,
    state,
    draft: o.isDraft === true,
    baseBranch: String(o.baseRefName ?? "") || "main",
    headBranch: o.headRefName,
    headRepo,
    fromFork,
    localBranch: pullRequestLocalBranch(base),
    pushProblem,
  };
}

/** A fork's clone address in the same style (ssh or https) and on the same host as origin's. */
export function forkRemoteUrl(origin: string, headRepo: string): string | null {
  const web = githubRepoWebUrl(origin);
  if (!web || !/^[\w.-]+\/[\w.-]+$/.test(headRepo)) return null;
  const host = new URL(web).host;
  const ssh = /^(ssh:\/\/|[^@/\s]+@[^:/\s]+:(?!\/\/))/i.test(origin.trim());
  return ssh ? `git@${host}:${headRepo}.git` : `https://${host}/${headRepo}.git`;
}

/** What the thread needs to remember about the pull request it works on. */
export interface PullRequestCheckout {
  number: number;
  url: string;
  /** Where its commits are pushed: the pull request's own branch. */
  pushTarget: PushTarget;
  pushProblem: string | null;
}

/**
 * Make the pull request's branch in `repo` (without switching anything), tracking the
 * branch in the repository it comes from, so the thread's worktree can check it out and
 * pushes go back to the pull request. A fork gets a remote of its own.
 */
export async function preparePullRequestBranch(repo: string, pr: PullRequestLookup): Promise<PullRequestCheckout> {
  const ws = new GitWorkspace(repo);
  const local = assertSafeRef(pr.localBranch, "branch name");
  const head = assertSafeRef(pr.headBranch, "branch name");
  const exists = (await ws.git(["rev-parse", "--verify", "-q", `refs/heads/${local}`], { allowFail: true })).trim();
  let remote = "origin";
  let pushProblem = pr.pushProblem;
  if (pr.fromFork && pr.headRepo) {
    const url = forkRemoteUrl(await originUrl(ws), pr.headRepo);
    if (url) remote = await addForkRemote(ws, pr.headRepo.split("/")[0]!, url);
  }
  const tracking = `refs/remotes/${remote}/${head}`;
  // GitHub keeps every pull request's head under refs/pull, for when its fork can't be reached.
  const fallback = async (why: string): Promise<string> => {
    const kept = `refs/lemonlime/pull/${pr.number}`;
    const failed = await ws.fetch("origin", [`+refs/pull/${pr.number}/head:${kept}`]);
    if (failed !== null) throw new Error(`Couldn't fetch the pull request's branch: ${why}`);
    pushProblem ??= `LemonLime couldn't reach the repository this pull request comes from, so the agent can work on it here but can't push to it.`;
    return kept;
  };
  let start: string;
  if (pr.fromFork && remote === "origin") start = await fallback("its fork is gone");
  else {
    const failed = await ws.fetch(remote, [`+refs/heads/${head}:${tracking}`]);
    start = failed === null ? tracking : await fallback(failed);
  }
  if (!exists) await ws.git(["branch", "--no-track", "--end-of-options", local, start]);
  // Pulls and pushes from the thread go to the pull request's branch.
  if (start === tracking) await ws.git(["branch", `--set-upstream-to=${remote}/${head}`, "--end-of-options", local], { allowFail: true });
  return { number: pr.number, url: pr.url, pushTarget: { remote, branch: head }, pushProblem };
}

/** origin's address as configured (before any insteadOf rewriting), or "". */
async function originUrl(ws: GitWorkspace): Promise<string> {
  return (await ws.git(["config", "--get", "remote.origin.url"], { allowFail: true })).trim();
}

/** A remote named after the fork's owner (or reused if one already points at it). Returns its name. */
async function addForkRemote(ws: GitWorkspace, owner: string, url: string): Promise<string> {
  const names = (await ws.git(["remote"], { allowFail: true }))
    .split("\n")
    .map(r => r.trim())
    .filter(Boolean);
  const same = (u: string) => githubRepoWebUrl(u)?.toLowerCase() === githubRepoWebUrl(url)?.toLowerCase();
  for (const name of names) {
    if (same((await ws.git(["config", "--get", `remote.${name}.url`], { allowFail: true })).trim())) return name;
  }
  const taken = new Set(names);
  const base = owner.replace(/[^\w.-]/g, "-").replace(/^[-.]+/, "") || "fork";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  try {
    await ws.git(["remote", "add", "--", name, url]);
  } catch (err) {
    throw new Error(`Couldn't add a remote for the fork: ${gitError(err)}`);
  }
  return name;
}
