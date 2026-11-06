import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  excludePath(relPath: string): void {
    const exclude = join(this.dir, ".git", "info", "exclude");
    mkdirSync(join(this.dir, ".git", "info"), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const line = `/${relPath.replace(/^\/+/, "")}`;
    if (!current.split("\n").includes(line)) appendFileSync(exclude, `${current.endsWith("\n") || !current ? "" : "\n"}${line}\n`);
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
    const baseRef =
      (await this.git(["rev-parse", "--verify", "-q", base], { allowFail: true })).trim() ||
      (await this.git(["rev-parse", "--verify", "-q", `origin/${base}`], { allowFail: true })).trim() ||
      "HEAD";
    await this.git(["checkout", "-q", "-b", branch, baseRef]);
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
