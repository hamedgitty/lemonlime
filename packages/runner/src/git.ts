import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Commits made by the runner use this identity so they never depend on local git config. */
const AGENT_IDENTITY = ["-c", "user.name=LemonLime Agent", "-c", "user.email=agent@lemonlime.invalid"];
const MAX_DIFF_BYTES = 200_000;

/**
 * Put in front of every git call the runner makes. The agent can edit the repository's
 * config, so none of the runner's own git calls may run a program the config names: no
 * fsmonitor daemon, no hooks, no bare repositories found by walking up from a folder.
 */
export const SAFE_GIT_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "safe.bareRepository=explicit"];
/** Diffs never run an external diff tool or a textconv filter. */
export const SAFE_DIFF = ["--no-ext-diff", "--no-textconv"];
/** A git call that takes longer than this is killed. Network calls get longer. */
export const GIT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 15 * 60_000;

export interface GitRunOptions {
  cwd: string;
  timeout?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
}

/** Run git with the safe config, a time limit and no terminal prompts. Arguments are never shell-parsed. */
export function runGit(args: string[], o: GitRunOptions) {
  return run("git", [...SAFE_GIT_CONFIG, ...args], {
    cwd: o.cwd,
    maxBuffer: o.maxBuffer ?? 32 * 1024 * 1024,
    timeout: o.timeout ?? GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...o.env },
  });
}

/**
 * A branch name, ref or commit from outside the runner, or a refusal. Anything starting
 * with "-" could be read as an option, so it is never passed to git.
 */
export function assertSafeRef(ref: string, what = "ref"): string {
  // Letters, digits and the punctuation git allows in ref names; no spaces or control characters.
  if (!ref || ref.startsWith("-") || !/^[\w./@{}^~+=,:-]+$/.test(ref) || ref.includes("..") || ref.length > 250) {
    throw new Error(`Not a usable ${what}: ${JSON.stringify(ref.slice(0, 80))}`);
  }
  return ref;
}

/** A repository path from outside the runner: relative, inside the repo, not an option. */
export function assertSafePath(path: string): string {
  if (!path || path.startsWith("-") || path.startsWith("/") || path.split(/[\\/]/).includes("..") || path.includes("\0") || path.length > 4096) {
    throw new Error(`Not a usable path: ${JSON.stringify(path.slice(0, 80))}`);
  }
  return path;
}

export interface FileChange {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  truncated: boolean;
}

/** Git operations for one thread's working directory. */
export class GitWorkspace {
  constructor(
    readonly dir: string,
    /** git `credential.helper` to use for clone, fetch and push (cloud threads). */
    private readonly credentialHelper?: string,
  ) {}

  async git(args: string[], opts: { allowFail?: boolean; timeout?: number; env?: Record<string, string>; maxBuffer?: number } = {}): Promise<string> {
    try {
      const { stdout } = await runGit(args, {
        cwd: this.dir,
        ...(opts.timeout ? { timeout: opts.timeout } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
      });
      return stdout;
    } catch (err) {
      if (opts.allowFail) return "";
      throw err;
    }
  }

  /** Clone `repoUrl` into the directory if it is empty; make sure it is a git repo either way. */
  async ensureRepo(repoUrl?: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const empty = readdirSync(this.dir).length === 0;
    const helper = this.credentialHelper ? ["-c", `credential.helper=${this.credentialHelper}`] : [];
    if (empty && repoUrl) {
      await runGit([...helper, "clone", "--no-single-branch", "--", repoUrl, "."], { cwd: this.dir, timeout: NETWORK_TIMEOUT_MS });
    } else if (!existsSync(join(this.dir, ".git"))) {
      await this.git(["init", "-q"]);
      // Not empty (the runner's own data folder can be in here already), so clone by hand:
      // `git clone` refuses a folder with anything in it.
      if (repoUrl) {
        await this.git(["remote", "add", "--", "origin", repoUrl]);
        await runGit([...helper, "fetch", "-q", "origin"], { cwd: this.dir, timeout: NETWORK_TIMEOUT_MS });
        await this.git(["remote", "set-head", "origin", "--auto"], { allowFail: true });
      }
    }
    // Later fetches and pushes, by the runner or the agent, use the same helper. The
    // empty value first clears any helper inherited from system or global config.
    if (this.credentialHelper) {
      await this.git(["config", "--replace-all", "credential.helper", ""]);
      await this.git(["config", "--add", "credential.helper", this.credentialHelper]);
    }
  }

  /**
   * Push the current branch, setting it as upstream: to `origin` under the same name, or to
   * `target` (a pull request's branch in a fork). Returns null on success, or git's error.
   * Never forces: if the remote has moved on, the push is refused.
   */
  async push(branch: string, opts: { force?: boolean; target?: PushTarget } = {}): Promise<string | null> {
    const remote = opts.target?.remote ?? "origin";
    const remoteBranch = opts.target?.branch ?? branch;
    const remotes = (await this.git(["remote"], { allowFail: true })).split("\n").map(r => r.trim());
    if (!remotes.includes(remote)) return `no remote named ${remote}`;
    try {
      assertSafeRef(branch, "branch name");
      assertSafeRef(remote, "remote name");
      assertSafeRef(remoteBranch, "branch name");
      // After a rewind the branch moved back, so it's replaced; only ever the thread's own branch.
      await runGit(["push", "-q", "-u", ...(opts.force ? ["--force-with-lease"] : []), remote, `HEAD:refs/heads/${remoteBranch}`], {
        cwd: this.dir,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      });
      return null;
    } catch (err) {
      return String((err as { stderr?: string }).stderr ?? err)
        .trim()
        .split("\n")
        .slice(-3)
        .join("\n");
    }
  }

  /** Fetch from a remote (allowed to fail: offline is fine). Returns git's error, or null. */
  async fetch(remote: string, refspecs: string[], o: { timeout?: number } = {}): Promise<string | null> {
    assertSafeRef(remote, "remote name");
    for (const r of refspecs) if (r.startsWith("-")) throw new Error("Not a usable refspec");
    try {
      await this.git(["fetch", "-q", "--no-tags", "--no-recurse-submodules", remote, ...refspecs], { timeout: o.timeout ?? NETWORK_TIMEOUT_MS });
      return null;
    } catch (err) {
      return gitError(err);
    }
  }

  /**
   * Merge `ref` into the checked-out branch. On conflicts the merge is undone, so the
   * branch and files are as they were, and the conflicting files are returned.
   */
  async mergeFrom(ref: string, message: string): Promise<{ result: "merged" | "up_to_date" } | { result: "conflicts"; conflicts: string[] }> {
    assertSafeRef(ref, "ref");
    const before = await this.head();
    try {
      await this.git([...AGENT_IDENTITY, "merge", "-q", "--no-edit", "--no-verify", "-m", message, "--end-of-options", ref]);
    } catch (err) {
      const conflicts = (await this.git(["diff", "--name-only", "-z", "--diff-filter=U"], { allowFail: true })).split("\0").filter(Boolean);
      await this.git(["merge", "--abort"], { allowFail: true });
      if (conflicts.length) return { result: "conflicts", conflicts };
      throw new Error(`Couldn't merge ${ref}: ${gitError(err)}`);
    }
    return (await this.head()) === before ? { result: "up_to_date" } : { result: "merged" };
  }

  /** Keep runner data out of the repo without touching the user's .gitignore. */
  async excludePath(relPath: string): Promise<void> {
    // In a worktree `.git` is a file, so ask git where the exclude file lives.
    const gitPath = (await this.git(["rev-parse", "--git-path", "info/exclude"])).trim();
    const exclude = isAbsolute(gitPath) ? gitPath : resolve(this.dir, gitPath);
    mkdirSync(dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const line = `/${relPath.replace(/^\/+/, "")}`;
    if (!current.split("\n").includes(line)) appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}${line}\n`);
  }

  /**
   * Make this directory a git worktree of `source` with `branch` checked out, creating the
   * branch the first time: from `from` when given (a fork starts from the thread it came
   * from), else from `base`. With `existing`, the branch must already be there, locally or
   * on origin, and is never created from anything else. The user's own checkout of
   * `source` is never switched, and their uncommitted work there is never touched.
   * Returns warnings worth showing (submodules that couldn't be filled).
   */
  async ensureWorktree(source: string, branch: string, base: string, o: { from?: string; existing?: boolean } = {}): Promise<{ warnings: string[] }> {
    assertSafeRef(branch, "branch name");
    assertSafeRef(base, "base branch");
    if (o.from) assertSafeRef(o.from, "starting point");
    const src = new GitWorkspace(source);
    const srcCommon = await src.commonDir();
    if (!srcCommon) throw new Error(`${source} is not a git repository`);

    if (existsSync(join(this.dir, ".git"))) {
      // Reusing an earlier worktree: it must belong to the same repository.
      if ((await this.commonDir()) !== srcCommon) throw new Error(`${this.dir} already holds a different repository`);
      await this.ensureBranch(branch, base);
      return { warnings: [] };
    }
    if (existsSync(this.dir) && readdirSync(this.dir).length > 0) throw new Error(`${this.dir} is not empty and is not a worktree of ${source}`);
    if (!(await src.hasCommits())) throw new Error("This repository has no commits yet. Make a first commit, then start the thread.");

    mkdirSync(dirname(this.dir), { recursive: true });
    await src.git(["worktree", "prune"], { allowFail: true });
    const exists = (await src.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).trim();
    let args: string[];
    if (exists) args = ["worktree", "add", "-q", this.dir, branch];
    else if (o.existing) {
      const remote = (await src.git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`], { allowFail: true })).trim();
      if (!remote) throw new Error(`There's no branch named ${branch} in this repository, here or on origin.`);
      // Made from origin's copy and tracking it, so pulls and pushes go back to the same branch.
      args = ["worktree", "add", "-q", "--track", "-b", branch, this.dir, `refs/remotes/origin/${branch}`];
    } else {
      const start = o.from ? await src.resolveRef(o.from) : await src.resolveBase(base);
      if (!start) throw new Error(`Couldn't find ${o.from} to start the thread from.`);
      args = ["worktree", "add", "-q", "-b", branch, this.dir, start];
    }
    try {
      await src.git(args);
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? err);
      if (/already (checked out|used by worktree)/.test(msg)) {
        const where = /(?:checked out at|used by worktree at) '([^']+)'/.exec(msg)?.[1];
        throw new Error(checkedOutMessage(branch, where ?? null, source));
      }
      throw new Error(`Could not create a worktree for this thread: ${msg.trim()}`);
    }
    return { warnings: await this.fillSubmodules() };
  }

  /** Check out the repository's submodules, if it has any. A failure is a warning, not an error. */
  async fillSubmodules(): Promise<string[]> {
    if (!existsSync(join(this.dir, ".gitmodules"))) return [];
    try {
      await this.git(["submodule", "update", "--init", "--recursive"], { timeout: NETWORK_TIMEOUT_MS });
      return [];
    } catch (err) {
      return [`Couldn't check out this repository's submodules, so their folders are empty in this thread. Git said: ${gitError(err)}`];
    }
  }

  /** The commit `ref` names (a commit id, a local branch, or origin's copy of one), or "" if there's none. */
  async resolveRef(ref: string): Promise<string> {
    assertSafeRef(ref, "ref");
    return (
      (await this.git(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], { allowFail: true })).trim() ||
      (await this.git(["rev-parse", "--verify", "-q", "--end-of-options", `refs/remotes/origin/${ref}^{commit}`], { allowFail: true })).trim()
    );
  }

  /** Remove this worktree (keeping its branch and commits). Safe to call if it's already gone. */
  async removeWorktree(source: string): Promise<void> {
    const src = new GitWorkspace(source);
    await src.git(["worktree", "remove", "--force", this.dir], { allowFail: true });
    await src.git(["worktree", "prune"], { allowFail: true });
  }

  /** The repository's shared git directory, resolved, or "" if this isn't a repository. */
  async commonDir(): Promise<string> {
    if (!existsSync(this.dir)) return "";
    const out = (await this.git(["rev-parse", "--git-common-dir"], { allowFail: true })).trim();
    if (!out) return "";
    const abs = isAbsolute(out) ? out : resolve(this.dir, out);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }

  /** `base` as a local branch, else its remote-tracking branch, else HEAD. */
  async resolveBase(base: string): Promise<string> {
    assertSafeRef(base, "base branch");
    return (
      (await this.git(["rev-parse", "--verify", "-q", "--end-of-options", base], { allowFail: true })).trim() ||
      (await this.git(["rev-parse", "--verify", "-q", "--end-of-options", `origin/${base}`], { allowFail: true })).trim() ||
      "HEAD"
    );
  }

  async hasCommits(): Promise<boolean> {
    return (await this.git(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim().length > 0;
  }

  async currentBranch(): Promise<string> {
    return (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })).trim();
  }

  /**
   * Switch to the thread's branch, creating it from `base` the first time.
   * Never discards work: if the branch already exists it is simply checked out.
   */
  async ensureBranch(branch: string, base: string): Promise<void> {
    assertSafeRef(branch, "branch name");
    if ((await this.currentBranch()) === branch) return;
    const exists = (await this.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).trim();
    if (exists) {
      await this.git(["checkout", "-q", "--end-of-options", branch, "--"]);
      return;
    }
    const from = await this.resolveBase(base);
    if (from === "HEAD" && !(await this.hasCommits())) {
      // Brand-new repo: create the branch as an orphan so the first commit lands on it.
      await this.git(["checkout", "-q", "--orphan", branch]);
      return;
    }
    await this.git(["checkout", "-q", "-b", branch, from]);
  }

  /** Stage everything and describe what changed since the last commit. */
  async collectChanges(): Promise<FileChange[]> {
    await this.git(["add", "-A"]);
    // Diff against HEAD, or against git's empty tree before the first commit.
    const base = (await this.hasCommits()) ? "HEAD" : await this.emptyTree();
    const nameStatus = await this.git(["diff", ...SAFE_DIFF, "--cached", "--name-status", "-M", "--end-of-options", base, "--"]);

    const changes: FileChange[] = [];
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const [status = "", ...paths] = line.split("\t");
      const path = paths[paths.length - 1] ?? "";
      const change = statusToChange(status);
      let diff = await this.git(["diff", ...SAFE_DIFF, "--cached", "-M", "--end-of-options", base, "--", ...paths], { allowFail: true });
      let truncated = false;
      if (diff.length > MAX_DIFF_BYTES) {
        diff = diff.slice(0, MAX_DIFF_BYTES);
        truncated = true;
      }
      changes.push({ path, change, diff, truncated });
    }
    return changes;
  }

  /** The current commit, or null in a repo with none yet. */
  async head(): Promise<string | null> {
    return (await this.git(["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim() || null;
  }

  /**
   * Put the branch and files back to `commit`, keeping what was there at `backupRef` so it
   * can be recovered. Untracked files the agent left are kept (each turn commits its work).
   */
  async rewindTo(commit: string, backupRef: string): Promise<void> {
    assertSafeRef(commit, "commit");
    assertSafeRef(backupRef, "ref");
    await this.git(["update-ref", "--end-of-options", backupRef, "HEAD"]);
    await this.git(["reset", "-q", "--hard", "--end-of-options", commit, "--"]);
  }

  /** Commit staged changes on the current branch. Returns the new commit sha, or null if nothing changed. */
  async commit(message: string): Promise<string | null> {
    const staged = (await this.git(["diff", "--cached", "--name-only", "-z"], { allowFail: true })).length > 0;
    if (!staged) return null;
    await this.git([...AGENT_IDENTITY, "commit", "-q", "--no-verify", "-m", message]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /** Whether `ref` names a commit (not a tree or nothing). */
  async isCommit(ref: string): Promise<boolean> {
    if (!ref || ref.startsWith("-")) return false;
    return (await this.git(["rev-parse", "--verify", "-q", "--end-of-options", `${ref}^{commit}`], { allowFail: true })).trim().length > 0;
  }

  /** Object id of the empty tree, to diff against before the first commit. */
  emptyTreeId(): Promise<string> {
    return this.emptyTree();
  }

  /** Object id of the empty tree for this repo's hash format (sha1 or sha256). */
  private async emptyTree(): Promise<string> {
    // Hash empty input as a tree. Works on every OS (no /dev/null) and both hash formats.
    const pending = runGit(["hash-object", "-t", "tree", "--stdin"], { cwd: this.dir });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout.trim();
  }
}

/** Where the thread's branch is pushed when it isn't `origin` under the same name. */
export interface PushTarget {
  remote: string;
  branch: string;
}

/** The last few lines git printed for a failed call. */
export function gitError(err: unknown): string {
  return String((err as { stderr?: string }).stderr || (err as Error).message || err)
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
}

/** What to tell the user when a branch they picked is checked out somewhere else. */
export function checkedOutMessage(branch: string, where: string | null, source: string): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const inProject = where !== null && real(where) === real(source);
  const place = inProject ? "your project folder" : where ? where : "another folder";
  return `${branch} is checked out in ${place}, and a branch can only be checked out in one place at a time. Switch ${inProject ? "your project folder" : "that folder"} to another branch, or start the thread from ${branch} as a new branch instead.`;
}

function statusToChange(status: string): FileChange["change"] {
  switch (status[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

/** First line of a prompt, trimmed to a sensible commit subject. */
export function commitSubject(prompt: string): string {
  const first = prompt.trim().split("\n")[0]?.trim() ?? "";
  const subject = first.length > 72 ? `${first.slice(0, 69).trimEnd()}...` : first;
  return subject || "Agent changes";
}
