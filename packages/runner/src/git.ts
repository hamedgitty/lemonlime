import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Commits made by the runner use this identity so they never depend on local git config. */
const AGENT_IDENTITY = ["-c", "user.name=LemonLime Agent", "-c", "user.email=agent@lemonlime.invalid"];
const MAX_DIFF_BYTES = 200_000;

/**
 * Put in front of every git call the runner makes, whatever the repository's config says:
 * no fsmonitor daemon, no hooks, no bare repositories found by walking up from a folder,
 * and no remote whose address is a command to run.
 */
export const SAFE_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "safe.bareRepository=explicit",
  "-c",
  "protocol.ext.allow=never",
];
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
  /** Sent to git's standard input, which is then closed. */
  input?: string;
  /** The runner's own `credential.helper`, used in place of any the repository names. */
  credentialHelper?: string;
}

/*
 * The repository's own config (`.git/config`, a worktree's config, and any file those
 * include) can be edited by the agent, and many of its settings name a program that git
 * runs. The user's own config (global and system) is theirs and is trusted.
 *
 * Git has no switch that ignores the repository's config, and a setting can only be
 * overridden one key at a time. So before a git call the runner asks git for every setting
 * together with where it came from, and for each risky one the repository sets it passes
 * `-c` with the user's own value, or a harmless one when the user has none. Asking git,
 * not reading the file, means included files and worktree config are seen the way git
 * sees them. Settings that can't be overridden this way are handled on their own:
 *
 * - credential helpers are a list, so the list is emptied and the user's own helpers (or
 *   the runner's, for a cloud thread) are put back;
 * - address rewrites (`url.*.insteadOf`) can only be added to, so the runner refuses to
 *   talk to a remote while the repository has one;
 * - for a remote's upload and receive programs git keeps the first value it reads, so
 *   fetch and push name git's own on the command line, which comes before any config;
 * - external diff tools have no safe empty value, so diffs always get the SAFE_DIFF flags;
 * - hooks and the fsmonitor are off for every call (SAFE_GIT_CONFIG), and the runner's own
 *   commits and merges pass `--no-verify`;
 * - aliases need nothing: git never lets one replace a built-in command, and the runner
 *   only calls built-in commands.
 *
 * Large-file storage keeps working: its standard filter lines are let through.
 *
 * What this can't close: the config could change between the listing and the call.
 */

/**
 * Settings that name a program, or decide whether one runs, with what to use when the
 * user's own config has none. Signing is here so that commits are signed when the user's
 * config asks for it, with their key and their program, and not because the repository's does.
 */
const PROGRAM_SETTINGS: Record<string, () => string> = {
  "core.sshcommand": () => (process.env.GIT_SSH ? `'${process.env.GIT_SSH.replaceAll("'", "'\\''")}'` : "ssh"),
  "core.askpass": () => "",
  "core.editor": () => ":",
  "sequence.editor": () => ":",
  "core.pager": () => "cat",
  "core.alternaterefscommand": () => "",
  "gpg.program": () => "gpg",
  "gpg.openpgp.program": () => "gpg",
  "gpg.ssh.program": () => "ssh-keygen",
  "gpg.x509.program": () => "gpgsm",
  "gpg.ssh.defaultkeycommand": () => "",
  "gpg.format": () => "openpgp",
  "commit.gpgsign": () => "false",
  "tag.gpgsign": () => "false",
  "push.gpgsign": () => "false",
  "user.signingkey": () => "",
};
/** The same, for settings with a name in the middle (`merge.<name>.driver`). */
const PROGRAM_PATTERNS: [RegExp, string][] = [
  [/^pager\..+$/i, "false"],
  // A merge driver that always fails leaves the file as a conflict, which the runner reports.
  [/^merge\..+\.driver$/i, "false"],
];
/** The program git starts on the other end of a fetch or a push. Git uses the first one set. */
const REMOTE_PROGRAM = /^remote\..+\.(uploadpack|receivepack)$/i;
const FILTER_PROGRAM = /^filter\.(.+)\.(clean|smudge|process)$/i;
const CREDENTIAL_HELPER = /^credential\.(.+\.)?helper$/i;
const ADDRESS_REWRITE = /^url\..+\.(insteadof|pushinsteadof)$/i;
/**
 * Settings that say how far to trust the server on the other end. They name no program,
 * but with them the repository's own config could switch off the check that a push goes
 * to the real server. So they are the user's to set, with git's default otherwise. Each
 * can also be set for one address (`http.<address>.sslVerify`).
 */
const SERVER_TRUST: [RegExp, string, string][] = [
  [/^http\.(.+\.)?sslverify$/i, "http.sslverify", "true"],
  // Git's default: follow a redirect only on the first request to a remote.
  [/^http\.(.+\.)?followredirects$/i, "http.followredirects", "initial"],
];
/** The certificates git accepts when it checks a server. */
const TRUSTED_CERTIFICATES = /^http\.(.+\.)?(sslcainfo|sslcapath)$/i;
/** The filter lines large-file storage writes into a repository's config. */
const LFS_FILTERS: Record<string, string[]> = {
  clean: ["git-lfs clean -- %f", "git-lfs clean %f"],
  smudge: ["git-lfs smudge -- %f", "git-lfs smudge %f", "git-lfs smudge --skip -- %f", "git-lfs smudge --skip %f"],
  process: ["git-lfs filter-process", "git-lfs filter-process --skip"],
};
/** Commands that only read refs and objects, so no setting can make them run a program. */
const READS_ONLY = new Set(["rev-parse", "symbolic-ref", "merge-base", "rev-list", "hash-object", "update-ref"]);
/** Commands that print diffs. */
const PRINTS_DIFFS = new Set(["diff", "show", "log"]);
/** Commands that talk to a remote. */
const TALKS_TO_REMOTE = new Set(["fetch", "push", "pull", "clone", "ls-remote", "submodule"]);
const REMOTE_ACTIONS_THAT_TALK = new Set(["set-head", "update", "show", "prune"]);

interface ConfigEntry {
  /** Where git read it from: system, global, local, worktree or command. */
  scope: string;
  key: string;
  value: string;
}

/** The git command in a list of arguments, past any options in front of it. */
function commandIn(args: string[]): { name: string; at: number } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "-C") i++;
    else if (!a.startsWith("-")) return { name: a, at: i };
  }
  return { name: "", at: -1 };
}

const gitEnv = (extra?: Record<string, string>) => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: ":", GIT_PAGER: "cat", ...extra });

/** Every setting git would use in `cwd`, with where each came from. Empty when git can't say. */
async function readConfig(cwd: string): Promise<ConfigEntry[]> {
  const list = async (args: string[]) =>
    (
      await run("git", ["--no-pager", ...SAFE_GIT_CONFIG, "config", ...args], {
        cwd,
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: "SIGKILL",
        env: gitEnv(),
        windowsHide: true,
      })
    ).stdout
      .split("\0")
      .slice(0, -1);
  const entry = (scope: string, line: string): ConfigEntry => {
    const cut = line.indexOf("\n");
    // A key written with no value means "true".
    return cut < 0 ? { scope, key: line, value: "true" } : { scope, key: line.slice(0, cut), value: line.slice(cut + 1) };
  };
  try {
    const fields = await list(["--list", "--show-scope", "-z"]);
    const entries: ConfigEntry[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) entries.push(entry(fields[i]!, fields[i + 1]!));
    return entries;
  } catch {
    // A git too old to say where settings come from: read the repository's own, and take
    // the user's as unknown.
    try {
      return (await list(["--local", "--list", "-z"])).map(line => entry("local", line));
    } catch {
      return [];
    }
  }
}

/** What a git call needs so the repository's own config can't make it run a program. */
interface Guard {
  /** `-c` options, in front of the command. */
  config: string[];
  /** Options of the command itself, right after its name. */
  flags: string[];
}

/** A refusal that reads the same whether the caller shows the error or what git printed. */
function refusal(message: string): Error {
  return Object.assign(new Error(message), { stderr: message });
}

/**
 * Works out the guard for one call (see the note above). Throws for a call that would talk
 * to a remote in a way the repository's config has changed and that can't be undone.
 */
async function repoConfigGuard(args: string[], o: GitRunOptions): Promise<Guard> {
  const command = commandIn(args);
  const own = o.credentialHelper ? ["-c", "credential.helper=", "-c", `credential.helper=${o.credentialHelper}`] : [];
  if (READS_ONLY.has(command.name) || process.env.LEMONLIME_TRUST_REPO_GIT_CONFIG === "1") return { config: own, flags: [] };

  const entries = await readConfig(o.cwd);
  const theirs = entries.filter(e => e.scope === "local" || e.scope === "worktree");
  // Anything else git read is the user's: their global and system config, and whatever a
  // git build adds of its own.
  const users = entries.filter(e => e.scope !== "local" && e.scope !== "worktree" && e.scope !== "command");
  const usersValue = (key: string) => users.findLast(e => e.key === key)?.value;
  const set = new Map<string, string>();
  const flags: string[] = [];

  for (const { key, value } of theirs) {
    const lower = key.toLowerCase();
    const program = PROGRAM_SETTINGS[lower];
    if (program) {
      // gpg.program is an older name for gpg.openpgp.program, so either stands in for the other.
      const twin = lower === "gpg.program" ? "gpg.openpgp.program" : lower === "gpg.openpgp.program" ? "gpg.program" : null;
      set.set(key, usersValue(key) ?? (twin ? usersValue(twin) : undefined) ?? program());
      continue;
    }
    const pattern = PROGRAM_PATTERNS.find(([re]) => re.test(key));
    if (pattern) {
      set.set(key, usersValue(key) ?? pattern[1]);
      continue;
    }
    const filter = FILTER_PROGRAM.exec(key);
    if (filter) {
      if (filter[1] === "lfs" && LFS_FILTERS[filter[2]!.toLowerCase()]?.includes(value)) continue;
      const mine = usersValue(key);
      set.set(key, mine ?? "");
      // With its program gone, a filter marked as required would make git stop.
      if (mine === undefined) set.set(`filter.${filter[1]}.required`, "false");
      continue;
    }
    const trust = SERVER_TRUST.find(([re]) => re.test(key));
    if (trust) {
      set.set(key, usersValue(key) ?? usersValue(trust[1]) ?? trust[2]);
      continue;
    }
    const certificates = TRUSTED_CERTIFICATES.exec(key);
    if (certificates) {
      const mine = usersValue(key) ?? usersValue(`http.${certificates[2]!.toLowerCase()}`);
      if (mine !== undefined) set.set(key, mine);
      // There is no value that means "the usual ones", so without one of the user's own nothing is sent.
      else if (talksToRemote(args, command)) {
        throw refusal(
          `This repository's own git settings name the certificates to trust (${key}), so nothing was fetched or pushed. Move that setting to your own git config with "git config --global", or remove it from the repository.`,
        );
      }
      continue;
    }
    if (lower === "core.gitproxy") set.set("protocol.git.allow", "never");
    // Only the repository's own config can give a submodule a command to run as its update.
    else if (/^submodule\..+\.update$/i.test(key) && value.startsWith("!")) set.set(key, "checkout");
    else if (ADDRESS_REWRITE.test(key) && talksToRemote(args, command)) {
      throw refusal(
        `This repository's own git settings send addresses somewhere else (${key}), so nothing was fetched or pushed. Move that setting to your own git config with "git config --global", or remove it from the repository.`,
      );
    } else if (REMOTE_PROGRAM.test(key) && usersValue(key) === undefined && talksToRemote(args, command)) {
      if (command.name === "push") flags.push("--receive-pack=git-receive-pack");
      else if (command.name === "fetch" || command.name === "pull" || command.name === "ls-remote") flags.push("--upload-pack=git-upload-pack");
      else {
        throw refusal(
          `This repository's own git settings name a program to run for a remote (${key}), so nothing was fetched. Move that setting to your own git config with "git config --global", or remove it from the repository.`,
        );
      }
    }
  }

  const config = [...set].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  if (own.length) config.push(...own);
  // An empty helper empties the list git has built so far; the user's own go back in order.
  else if (theirs.some(e => CREDENTIAL_HELPER.test(e.key)))
    config.push("-c", "credential.helper=", ...users.filter(e => CREDENTIAL_HELPER.test(e.key)).flatMap(e => ["-c", `${e.key}=${e.value}`]));
  return { config, flags: [...new Set(flags)] };
}

function talksToRemote(args: string[], command: { name: string; at: number }): boolean {
  if (TALKS_TO_REMOTE.has(command.name)) return true;
  return command.name === "remote" && REMOTE_ACTIONS_THAT_TALK.has(args[command.at + 1] ?? "");
}

/**
 * Run git with the safe config, nothing the repository's own config could make it run, a
 * time limit and no terminal prompts. Arguments are never shell-parsed.
 */
export async function runGit(args: string[], o: GitRunOptions): Promise<{ stdout: string; stderr: string }> {
  const guard = await repoConfigGuard(args, o);
  const command = commandIn(args);
  const flags = [...guard.flags, ...(PRINTS_DIFFS.has(command.name) ? SAFE_DIFF.filter(f => !args.includes(f)) : [])];
  const guarded = flags.length ? [...args.slice(0, command.at + 1), ...flags, ...args.slice(command.at + 1)] : args;
  const pending = run("git", ["--no-pager", ...SAFE_GIT_CONFIG, ...guard.config, ...guarded], {
    cwd: o.cwd,
    maxBuffer: o.maxBuffer ?? 32 * 1024 * 1024,
    timeout: o.timeout ?? GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: gitEnv(o.env),
    windowsHide: true,
  });
  if (o.input !== undefined) pending.child.stdin?.end(o.input);
  return pending;
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
        ...(this.credentialHelper ? { credentialHelper: this.credentialHelper } : {}),
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
        ...(this.credentialHelper ? { credentialHelper: this.credentialHelper } : {}),
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
      const conflicts = (await this.git(["diff", ...SAFE_DIFF, "--name-only", "-z", "--diff-filter=U"], { allowFail: true })).split("\0").filter(Boolean);
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
    // With -z git prints names as they are, whatever characters they hold: a status, then
    // the path, or the old and new path for a rename.
    const fields = (await this.git(["diff", ...SAFE_DIFF, "--cached", "--name-status", "-z", "-M", "--end-of-options", base, "--"])).split("\0");

    const changes: FileChange[] = [];
    for (let i = 0; i < fields.length;) {
      const status = fields[i++] ?? "";
      if (!status) continue;
      const count = /^[RC]/.test(status) ? 2 : 1;
      const paths = fields.slice(i, i + count);
      i += count;
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
    const staged = (await this.git(["diff", ...SAFE_DIFF, "--cached", "--name-only", "-z"], { allowFail: true })).length > 0;
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
    const { stdout } = await runGit(["hash-object", "-t", "tree", "--stdin"], { cwd: this.dir, input: "" });
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
