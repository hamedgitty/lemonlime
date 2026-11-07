import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Commits made by the runner use this identity so they never depend on local git config. */
const AGENT_IDENTITY = ["-c", "user.name=LemonLime Agent", "-c", "user.email=agent@lemonlime.invalid"];
const MAX_DIFF_BYTES = 200_000;

export interface FileChange {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  diff: string;
  truncated: boolean;
}

/** Git operations for one thread's working directory. */
export class GitWorkspace {
  constructor(readonly dir: string) {}

  async git(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await run("git", args, { cwd: this.dir, maxBuffer: 32 * 1024 * 1024 });
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
    if (empty && repoUrl) {
      await run("git", ["clone", "--no-single-branch", repoUrl, "."], { cwd: this.dir, maxBuffer: 32 * 1024 * 1024 });
    } else if (!existsSync(join(this.dir, ".git"))) {
      await this.git(["init", "-q"]);
    }
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
   * branch from `base` the first time. The user's own checkout of `source` is never
   * switched, and their uncommitted work there is never touched.
   */
  async ensureWorktree(source: string, branch: string, base: string): Promise<void> {
    const src = new GitWorkspace(source);
    const srcCommon = await src.commonDir();
    if (!srcCommon) throw new Error(`${source} is not a git repository`);

    if (existsSync(join(this.dir, ".git"))) {
      // Reusing an earlier worktree: it must belong to the same repository.
      if ((await this.commonDir()) !== srcCommon) throw new Error(`${this.dir} already holds a different repository`);
      await this.ensureBranch(branch, base);
      return;
    }
    if (existsSync(this.dir) && readdirSync(this.dir).length > 0) throw new Error(`${this.dir} is not empty and is not a worktree of ${source}`);
    if (!(await src.hasCommits())) throw new Error("This repository has no commits yet. Make a first commit, then start the thread.");

    mkdirSync(dirname(this.dir), { recursive: true });
    await src.git(["worktree", "prune"], { allowFail: true });
    const exists = (await src.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).trim();
    try {
      if (exists) await src.git(["worktree", "add", "-q", this.dir, branch]);
      else await src.git(["worktree", "add", "-q", "-b", branch, this.dir, await src.resolveBase(base)]);
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? err);
      if (/already (checked out|used by worktree)/.test(msg)) {
        throw new Error(`The branch ${branch} is checked out in another folder. Switch that folder to a different branch, then start the thread again.`);
      }
      throw new Error(`Could not create a worktree for this thread: ${msg.trim()}`);
    }
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
    return (
      (await this.git(["rev-parse", "--verify", "-q", base], { allowFail: true })).trim() ||
      (await this.git(["rev-parse", "--verify", "-q", `origin/${base}`], { allowFail: true })).trim() ||
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
    if ((await this.currentBranch()) === branch) return;
    const exists = (await this.git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).trim();
    if (exists) {
      await this.git(["checkout", "-q", branch]);
      return;
    }
    if (!(await this.hasCommits())) {
      // Brand-new repo: create the branch as an orphan so the first commit lands on it.
      await this.git(["checkout", "-q", "--orphan", branch]);
      return;
    }
    await this.git(["checkout", "-q", "-b", branch, await this.resolveBase(base)]);
  }

  /** Stage everything and describe what changed since the last commit. */
  async collectChanges(): Promise<FileChange[]> {
    await this.git(["add", "-A"]);
    // Diff against HEAD, or against git's empty tree before the first commit.
    const base = (await this.hasCommits()) ? "HEAD" : await this.emptyTree();
    const nameStatus = await this.git(["diff", "--cached", "--name-status", "-M", base]);

    const changes: FileChange[] = [];
    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const [status = "", ...paths] = line.split("\t");
      const path = paths[paths.length - 1] ?? "";
      const change = statusToChange(status);
      let diff = await this.git(["diff", "--cached", "-M", base, "--", ...paths], { allowFail: true });
      let truncated = false;
      if (diff.length > MAX_DIFF_BYTES) {
        diff = diff.slice(0, MAX_DIFF_BYTES);
        truncated = true;
      }
      changes.push({ path, change, diff, truncated });
    }
    return changes;
  }

  /** Commit staged changes on the current branch. Returns the new commit sha, or null if nothing changed. */
  async commit(message: string): Promise<string | null> {
    const staged = (await this.git(["diff", "--cached", "--name-only", "-z"], { allowFail: true })).length > 0;
    if (!staged) return null;
    await this.git([...AGENT_IDENTITY, "commit", "-q", "--no-verify", "-m", message]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /** Object id of the empty tree for this repo's hash format (sha1 or sha256). */
  private async emptyTree(): Promise<string> {
    // Hash empty input as a tree. Works on every OS (no /dev/null) and both hash formats.
    const pending = run("git", ["hash-object", "-t", "tree", "--stdin"], { cwd: this.dir });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout.trim();
  }
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
