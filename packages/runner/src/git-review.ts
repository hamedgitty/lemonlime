import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  compareUrlFor,
  type BranchCommit,
  type DiffHunk,
  type DiffScope,
  type GitDiffResponse,
  type GitPullRequestResponse,
  type GitStatusResponse,
  type UpdateFromBaseResponse,
  type PullRequestDraft,
  type PullRequestInfo,
  type ReviewFile,
  type ReviewFileStatus,
} from "@lemonlime/protocol";
import { assertSafePath, assertSafeRef, commitSubject, SAFE_DIFF, type GitWorkspace, type PushTarget } from "./git.ts";
import type { PullRequestWatcher, WatchSnapshot } from "./pr-watch.ts";

const run = promisify(execFile);

/** Size limits for one diff answer, so a huge change can't flood the app. */
export interface DiffCaps {
  /** Files listed with their hunks; the rest are counted in `moreFiles`. */
  maxFiles: number;
  /** One file's patch text; longer ones keep their first hunks and say `truncated`. */
  maxFileBytes: number;
  /** All patch text together; files after the limit come without hunks (ask for them by path). */
  maxTotalBytes: number;
}
export const DEFAULT_DIFF_CAPS: DiffCaps = { maxFiles: 400, maxFileBytes: 256 * 1024, maxTotalBytes: 3 * 1024 * 1024 };
const MAX_COMMITS = 200;
const MAX_CONTEXT = 100_000;
const GH_TIMEOUT_MS = 60_000;
/** How often status fetches the base branch, so "behind" stays current without hammering the remote. */
const BASE_FETCH_EVERY_MS = 5 * 60_000;

export interface DiffQuery {
  scope: DiffScope;
  commit?: string;
  /** Just this file (e.g. to show more context around it). */
  path?: string;
  /** The file's path before a rename, so the rename is still found. */
  oldPath?: string;
  /** Lines of context around each change (git's default is 3). */
  context?: number;
}

/** Runs the GitHub CLI; replaceable in tests. Resolves with stdout or rejects like execFile. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGh: GhRunner = async (args, cwd) => {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
  // Apps opened from the Dock get a short PATH, so also look where package managers put gh.
  const candidates = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
  let last: unknown;
  for (const bin of candidates) {
    try {
      const { stdout } = await run(bin, args, { cwd, env, timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      last = err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw last;
};

/** The thread's branch as a reviewer sees it: real git diffs, push and pull requests. */
export class GitReview {
  private ghState: { at: number; value: GitStatusResponse["gh"] } | null = null;
  private fetchedBaseAt = 0;
  /** Watches the pull request and wakes the agent (set by the thread). */
  watcher: PullRequestWatcher | null = null;

  constructor(
    private readonly ws: GitWorkspace,
    private readonly o: {
      branch: string;
      baseBranch: string;
      /** Used as the pull request title when none is given. */
      title: () => string;
      threadId: string;
      gh?: GhRunner;
      caps?: Partial<DiffCaps>;
      /** The thread's first message, for the pull request's description. */
      firstMessage?: () => string;
      /** Where the branch is pushed, when not origin under the same name (a fork's pull request). */
      pushTarget?: PushTarget;
      /** The thread works on this pull request (it was started from it). */
      pullRequestNumber?: number;
      /** Why the branch can't be pushed, when it can't (a fork that doesn't allow edits). */
      pushProblem?: string;
      /** Why the branch can't be changed right now (the agent is working), or null. */
      busy?: () => string | null;
      /** The branch moved without a turn (a merge from the base branch). */
      onHeadMoved?: () => void;
      /** The folder is the thread's own (a worktree or a clone), so the runner may merge into it. */
      ownFolder?: boolean;
      /** Fetch the base branch now and then for "behind" (default true; tests turn it off). */
      fetchBase?: boolean;
    },
  ) {
    assertSafeRef(o.branch, "branch name");
    assertSafeRef(o.baseBranch, "base branch");
  }

  /** The remote and branch the thread's branch is pushed to. */
  private get target(): PushTarget {
    return this.o.pushTarget ?? { remote: "origin", branch: this.o.branch };
  }

  /**
   * The base branch to compare with and merge from: origin's copy when it has everything
   * the local one has (it's then the newer one), else the local branch, else origin's.
   */
  async baseTip(): Promise<{ ref: string; name: string } | null> {
    const b = this.o.baseBranch;
    const has = async (ref: string) => (await this.ws.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { allowFail: true })).trim().length > 0;
    const local = (await has(`refs/heads/${b}`)) ? { ref: `refs/heads/${b}`, name: b } : null;
    const remote = (await has(`refs/remotes/origin/${b}`)) ? { ref: `refs/remotes/origin/${b}`, name: `origin/${b}` } : null;
    if (local && remote) return (await this.isAncestor(local.ref, remote.ref)) ? remote : local;
    return local ?? remote;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await this.ws.git(["merge-base", "--is-ancestor", "--end-of-options", a, b]);
      return true;
    } catch {
      return false;
    }
  }

  /** Bring the base branch's latest into view now and then; never waits for the network. */
  private fetchBaseSometimes(hasRemote: boolean): void {
    if (!hasRemote || this.o.fetchBase === false || Date.now() - this.fetchedBaseAt < BASE_FETCH_EVERY_MS) return;
    this.fetchedBaseAt = Date.now();
    const b = this.o.baseBranch;
    void this.ws.fetch("origin", [`+refs/heads/${b}:refs/remotes/origin/${b}`], { timeout: 60_000 }).catch(() => null);
  }

  private get gh(): GhRunner {
    return this.o.gh ?? defaultGh;
  }

  /** Where the branch left the base branch, or HEAD when there's no base to compare with. */
  async mergeBase(): Promise<string> {
    if (!(await this.ws.hasCommits())) return this.ws.emptyTreeId();
    const base = (await this.baseTip())?.ref ?? (await this.ws.resolveBase(this.o.baseBranch));
    if (base === "HEAD") return (await this.ws.head()) ?? "HEAD";
    return (await this.ws.git(["merge-base", "--end-of-options", "HEAD", base], { allowFail: true })).trim() || ((await this.ws.head()) ?? "HEAD");
  }

  async commits(mergeBase?: string): Promise<BranchCommit[]> {
    if (!(await this.ws.hasCommits())) return [];
    const from = mergeBase ?? (await this.mergeBase());
    const range = from === (await this.ws.head()) ? null : (await this.ws.isCommit(from)) ? `${from}..HEAD` : "HEAD";
    if (!range) return [];
    const out = await this.ws.git(["log", `--max-count=${MAX_COMMITS}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e", "--end-of-options", range, "--"], {
      allowFail: true,
    });
    return out
      .split("\x1e")
      .map(r => r.trim())
      .filter(Boolean)
      .map(r => {
        const [sha = "", shortSha = "", subject = "", author = "", date = ""] = r.split("\x1f");
        return { sha, shortSha, subject, author, date };
      });
  }

  async diff(q: DiffQuery): Promise<GitDiffResponse> {
    const caps = { ...DEFAULT_DIFF_CAPS, ...this.o.caps };
    const path = q.path ? [assertSafePath(q.path), ...(q.oldPath ? [assertSafePath(q.oldPath)] : [])] : undefined;
    const context = Math.max(0, Math.min(MAX_CONTEXT, Math.floor(q.context ?? 3)));
    const mergeBase = await this.mergeBase();
    const commits = await this.commits(mergeBase);

    if (q.scope === "commit") {
      const sha = assertSafeRef(q.commit ?? "", "commit");
      if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new Error("Pick a commit by its id.");
      const full = (await this.ws.git(["rev-parse", "--verify", "-q", "--end-of-options", `${sha}^{commit}`], { allowFail: true })).trim();
      if (!full) throw new Error("That commit isn't in this repository.");
      const parent =
        (await this.ws.git(["rev-parse", "--verify", "-q", "--end-of-options", `${full}^`], { allowFail: true })).trim() || (await this.ws.emptyTreeId());
      const files = await this.collect([parent, full], {}, { path, context, caps });
      return { scope: "commit", commit: full, base: parent, ...files, commits };
    }

    const base = q.scope === "uncommitted" ? ((await this.ws.head()) ?? (await this.ws.emptyTreeId())) : mergeBase;
    const files = await this.withWorkingTreeIndex(env => this.collect([base], env, { path, context, caps }));
    return { scope: q.scope, base, ...files, commits };
  }

  async status(): Promise<GitStatusResponse> {
    const mergeBase = await this.mergeBase();
    const head = await this.ws.head();
    const porcelain = await this.ws.git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true });
    const uncommittedFiles = countPorcelain(porcelain);
    const committedFiles = head
      ? (await this.ws.git(["diff", ...SAFE_DIFF, "--name-only", "-z", "--end-of-options", mergeBase, "HEAD", "--"], { allowFail: true }))
          .split("\0")
          .filter(Boolean).length
      : 0;
    const ownRange = head && (await this.ws.isCommit(mergeBase)) ? `${mergeBase}..HEAD` : "HEAD";
    const commits = head ? Number((await this.ws.git(["rev-list", "--count", "--end-of-options", ownRange, "--"], { allowFail: true })).trim() || 0) : 0;
    const remoteUrl = (await this.ws.git(["remote", "get-url", "--", "origin"], { allowFail: true })).trim();
    const tracking = `refs/remotes/${this.target.remote}/${this.target.branch}`;
    const pushed = Boolean((await this.ws.git(["rev-parse", "--verify", "-q", "--end-of-options", tracking], { allowFail: true })).trim());
    const unpushed =
      head && pushed
        ? Number((await this.ws.git(["rev-list", "--count", "--end-of-options", `${tracking}..HEAD`, "--"], { allowFail: true })).trim() || 0)
        : commits;
    const tip = head ? await this.baseTip() : null;
    const behind = tip
      ? Number((await this.ws.git(["rev-list", "--count", "--end-of-options", `HEAD..${tip.ref}`, "--"], { allowFail: true })).trim() || 0)
      : 0;
    this.fetchBaseSometimes(Boolean(remoteUrl));
    return {
      branch: this.o.branch,
      baseBranch: this.o.baseBranch,
      uncommittedFiles,
      committedFiles,
      commits,
      unpushed,
      behind,
      hasRemote: Boolean(remoteUrl),
      pushed,
      compareUrl: remoteUrl ? compareUrlFor(remoteUrl, this.o.baseBranch, this.o.branch) : null,
      gh: remoteUrl ? await this.ghReady(remoteUrl) : "missing",
    };
  }

  /** Push the thread's branch to origin (or the pull request's fork). Null on success, else what git said. */
  async push(): Promise<string | null> {
    if (this.o.pushProblem) return this.o.pushProblem;
    return this.ws.push(this.o.branch, this.o.pushTarget ? { target: this.o.pushTarget } : {});
  }

  /**
   * Merge the base branch's new commits into the thread's branch, in the thread's own folder.
   * On conflicts nothing changes: the merge is undone and the conflicting files are listed,
   * so the agent can be asked to do it.
   */
  async updateFromBase(): Promise<UpdateFromBaseResponse> {
    if (!this.o.ownFolder) throw new ReviewError(409, "This thread works in your own folder, so LemonLime won't merge into it. Run git merge yourself.");
    const busy = this.o.busy?.();
    if (busy) throw new ReviewError(409, busy);
    const b = this.o.baseBranch;
    const remoteUrl = (await this.ws.git(["remote", "get-url", "--", "origin"], { allowFail: true })).trim();
    if (remoteUrl) {
      await this.ws.fetch("origin", [`+refs/heads/${b}:refs/remotes/origin/${b}`], { timeout: 120_000 });
      this.fetchedBaseAt = Date.now();
    }
    const tip = await this.baseTip();
    if (!tip) throw new ReviewError(409, `There's no ${b} branch to update from.`);
    const tracked = await this.ws.git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no"], { allowFail: true });
    if (countPorcelain(tracked) > 0)
      throw new ReviewError(409, `Some changes aren't committed yet. Commit them (or ask the agent to) before updating from ${b}.`);
    const r = await this.ws.mergeFrom(tip.ref, `Merge ${tip.name} into ${this.o.branch}`);
    if (r.result === "merged") this.o.onHeadMoved?.();
    return { result: r.result, conflicts: r.result === "conflicts" ? r.conflicts : [], base: tip.name };
  }

  /** A title and description for the pull request, from the thread's first message and its commits. */
  async draft(): Promise<PullRequestDraft> {
    const commits = await this.commits();
    const files = (await this.status()).committedFiles;
    return draftPullRequest({
      title: this.o.title(),
      firstMessage: this.o.firstMessage?.() ?? "",
      commits: commits.map(c => c.subject).reverse(),
      files,
      branch: this.o.branch,
    });
  }

  /** The branch's pull request, when `gh` is here and signed in. */
  async pullRequest(): Promise<GitPullRequestResponse> {
    const remoteUrl = (await this.ws.git(["remote", "get-url", "--", "origin"], { allowFail: true })).trim();
    const compareUrl = remoteUrl ? compareUrlFor(remoteUrl, this.o.baseBranch, this.o.branch) : null;
    const extra = { ...(this.watcher ? { watch: this.watcher.state } : {}), ...(this.o.pushProblem ? { pushProblem: this.o.pushProblem } : {}) };
    if (!remoteUrl || (await this.ghReady(remoteUrl)) !== "ready") return { pullRequest: null, compareUrl, ...extra };
    return { pullRequest: await this.viewPullRequest(), compareUrl, ...extra };
  }

  /** Whether `gh` can answer for this repository right now. */
  async ghUsable(): Promise<boolean> {
    const remoteUrl = (await this.ws.git(["remote", "get-url", "--", "origin"], { allowFail: true })).trim();
    return Boolean(remoteUrl) && (await this.ghReady(remoteUrl)) === "ready";
  }

  /** What the pull request watch needs to see: state, checks, mergeability and comments. Null without one. */
  async watchSnapshot(): Promise<WatchSnapshot | null> {
    if (!(await this.ghUsable())) return null;
    const which = this.o.pullRequestNumber ? String(this.o.pullRequestNumber) : this.o.branch;
    let view: unknown;
    try {
      view = JSON.parse(
        await this.gh(["pr", "view", "--json", "number,url,state,mergeable,headRefOid,statusCheckRollup,comments,reviews", "--", which], this.ws.dir),
      );
    } catch {
      return null;
    }
    const number = (view as { number?: unknown }).number;
    let inline: unknown = [];
    if (typeof number === "number") {
      try {
        inline = JSON.parse(await this.gh(["api", `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100&sort=created&direction=desc`], this.ws.dir));
      } catch {
        inline = [];
      }
    }
    return parseWatchSnapshot(view, inline);
  }

  /**
   * Push, then open a pull request with `gh` (or return the one already open). Without
   * `gh`, the answer has the compare page to open in the browser instead.
   */
  async createPullRequest(body: { title?: string; body?: string; draft?: boolean }): Promise<GitPullRequestResponse> {
    const remoteUrl = (await this.ws.git(["remote", "get-url", "--", "origin"], { allowFail: true })).trim();
    if (!remoteUrl) throw new ReviewError(409, "This repository has no remote named origin to open a pull request on.");
    const problem = await this.push();
    if (problem) throw new ReviewError(409, `Couldn't push ${this.o.branch}: ${problem}`);
    const compareUrl = compareUrlFor(remoteUrl, this.o.baseBranch, this.o.branch);
    if ((await this.ghReady(remoteUrl)) !== "ready") return { pullRequest: null, compareUrl };
    const existing = await this.viewPullRequest();
    if (existing && existing.state === "open") return { pullRequest: existing, compareUrl };
    const drafted = body.title && body.body !== undefined ? null : await this.draft();
    const title = (body.title || drafted?.title || `Changes from LemonLime thread ${this.o.threadId}`).slice(0, 200);
    const text = body.body ?? drafted?.body ?? "";
    try {
      await this.gh(
        ["pr", "create", "--head", this.o.branch, "--base", this.o.baseBranch, "--title", title, "--body", text, ...(body.draft ? ["--draft"] : [])],
        this.ws.dir,
      );
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr ?? err).trim();
      if (!/already exists/i.test(msg)) throw new ReviewError(422, `GitHub didn't open the pull request: ${msg.split("\n").slice(-2).join(" ")}`);
    }
    return { pullRequest: await this.viewPullRequest(), compareUrl };
  }

  private async viewPullRequest(): Promise<PullRequestInfo | null> {
    try {
      const which = this.o.pullRequestNumber ? String(this.o.pullRequestNumber) : this.o.branch;
      const out = await this.gh(["pr", "view", "--json", "url,number,state,isDraft,statusCheckRollup", "--", which], this.ws.dir);
      return parseGhPullRequest(JSON.parse(out));
    } catch {
      return null;
    }
  }

  private async ghReady(remoteUrl: string): Promise<GitStatusResponse["gh"]> {
    if (this.ghState && Date.now() - this.ghState.at < 60_000) return this.ghState.value;
    let value: GitStatusResponse["gh"];
    const host = remoteHost(remoteUrl);
    try {
      await this.gh(["auth", "status", ...(host ? ["--hostname", host] : [])], this.ws.dir);
      value = "ready";
    } catch (err) {
      value = (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "signed_out";
    }
    this.ghState = { at: Date.now(), value };
    return value;
  }

  /**
   * Run `fn` against a scratch index holding the working tree as it is now (untracked
   * files included), so working-tree diffs never touch the real index the agent uses.
   */
  private async withWorkingTreeIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "lemonlime-index-"));
    const index = join(dir, "index");
    try {
      const real = (await this.ws.git(["rev-parse", "--git-path", "index"], { allowFail: true })).trim();
      const realPath = real ? (isAbsolute(real) ? real : resolve(this.ws.dir, real)) : "";
      if (realPath && existsSync(realPath)) {
        // Start from the real index so unchanged files aren't hashed again. Keep its time:
        // git trusts cached file stats only when the index is older than the files, so a
        // fresh copy would hide edits made in the same second.
        copyFileSync(realPath, index);
        const { atime, mtime } = statSync(realPath);
        utimesSync(index, atime, mtime);
      }
      const env = { GIT_INDEX_FILE: index };
      await this.ws.git(["add", "-A"], { env });
      return await fn(env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Files between two trees with their hunks, within the caps. */
  private async collect(
    range: string[],
    env: Record<string, string>,
    o: { path: string[] | undefined; context: number; caps: DiffCaps },
  ): Promise<{ files: ReviewFile[]; moreFiles: number }> {
    const opts = { allowFail: true, env, maxBuffer: 64 * 1024 * 1024 };
    // With a scratch index, compare it (the working tree) with the one tree in `range`.
    const cached = env.GIT_INDEX_FILE ? ["--cached"] : [];
    const tail = [...cached, "--end-of-options", ...range, "--", ...(o.path ?? [])];
    const nameStatus = await this.ws.git(["diff", ...SAFE_DIFF, "--no-color", "-M", "--name-status", "-z", ...tail], opts);
    const numstat = await this.ws.git(["diff", ...SAFE_DIFF, "--no-color", "-M", "--numstat", "-z", ...tail], opts);
    const listed = mergeStats(parseNameStatus(nameStatus), parseNumstat(numstat));
    const shown = listed.slice(0, o.caps.maxFiles);
    const moreFiles = listed.length - shown.length;
    if (!shown.length) return { files: [], moreFiles };

    const patchArgs = (paths: string[]) => [
      "diff",
      ...SAFE_DIFF,
      "--no-color",
      "-M",
      `-U${o.context}`,
      ...cached,
      "--end-of-options",
      ...range,
      "--",
      ...paths,
    ];
    const pathsOf = (f: (typeof shown)[number]) => (f.oldPath ? [f.oldPath, f.path] : [f.path]);
    // One patch for everything, split per file; if the pieces don't line up, ask per file.
    let chunks = splitPatch(await this.ws.git(patchArgs(shown.flatMap(pathsOf)), opts));
    if (chunks.length !== shown.length) {
      chunks = [];
      for (const f of shown) chunks.push(splitPatch(await this.ws.git(patchArgs(pathsOf(f)), opts))[0] ?? "");
    }

    let total = 0;
    const files = shown.map((f, i) => {
      const chunk = chunks[i] ?? "";
      const binary = f.binary || /^(Binary files .* differ|GIT binary patch)$/m.test(chunk);
      if (binary) return { ...f, binary: true, hunks: [], truncated: false };
      if (total >= o.caps.maxTotalBytes) return { ...f, binary: false, hunks: [], truncated: chunk.length > 0 };
      const { hunks, truncated } = parseHunks(chunk, Math.min(o.caps.maxFileBytes, o.caps.maxTotalBytes - total));
      total += hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.length + 1, h.header.length), 0);
      return { ...f, binary: false, hunks, truncated };
    });
    return { files, moreFiles };
  }
}

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Listed {
  path: string;
  oldPath?: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

const STATUS: Record<string, ReviewFileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type_changed" };

/** `git diff --name-status -z` → status and paths. */
export function parseNameStatus(out: string): { status: ReviewFileStatus; path: string; oldPath?: string }[] {
  const parts = out.split("\0");
  const list: { status: ReviewFileStatus; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++] ?? "";
    if (!code) continue;
    const status = STATUS[code[0]!] ?? "modified";
    if (status === "renamed" || status === "copied") {
      const oldPath = parts[i++] ?? "";
      const path = parts[i++] ?? "";
      list.push({ status, path, oldPath });
    } else list.push({ status, path: parts[i++] ?? "" });
  }
  return list;
}

/** `git diff --numstat -z` → counts per (new) path; binary files have no counts. */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = out.split("\0");
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < parts.length;) {
    const head = parts[i++] ?? "";
    if (!head) continue;
    const [add = "", del = "", inline = ""] = head.split("\t");
    let path = inline;
    // Renames: the path field is empty and the old and new paths follow.
    if (!inline) {
      i++;
      path = parts[i++] ?? "";
    }
    const binary = add === "-" && del === "-";
    map.set(path, { additions: binary ? 0 : Number(add) || 0, deletions: binary ? 0 : Number(del) || 0, binary });
  }
  return map;
}

function mergeStats(names: ReturnType<typeof parseNameStatus>, stats: ReturnType<typeof parseNumstat>): Listed[] {
  return names.map(n => ({ ...n, ...(stats.get(n.path) ?? { additions: 0, deletions: 0, binary: false }) }));
}

/** A multi-file patch → one piece per `diff --git` header, in order. */
export function splitPatch(patch: string): string[] {
  if (!patch) return [];
  const out: string[] = [];
  let start = -1;
  const re = /^diff --git /gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) {
    if (start >= 0) out.push(patch.slice(start, m.index));
    start = m.index;
  }
  if (start >= 0) out.push(patch.slice(start));
  return out;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One file's patch → hunks, stopping (and saying so) once `maxBytes` of text is used. */
export function parseHunks(chunk: string, maxBytes: number): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let size = 0;
  const lines = chunk.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = HUNK.exec(line);
    if (m) {
      size += line.length + 1;
      if (size > maxBytes) return { hunks, truncated: true };
      cur = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = line[0];
    if (c !== " " && c !== "+" && c !== "-" && c !== "\\" && line !== "") continue;
    size += line.length + 1;
    if (size > maxBytes) {
      if (!cur.lines.length) hunks.pop();
      return { hunks, truncated: true };
    }
    // An empty line inside a hunk is a context line whose space was trimmed by an editor.
    cur.lines.push(line === "" ? " " : line);
  }
  return { hunks, truncated: false };
}

/** Entries in `git status --porcelain=v1 -z` (a rename's old path doesn't count twice). */
export function countPorcelain(out: string): number {
  const parts = out.split("\0");
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (!p) continue;
    n++;
    if (p[0] === "R" || p[0] === "C") i++;
  }
  return n;
}

function remoteHost(remote: string): string | null {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/.exec(remote);
  if (/^[a-z]+:\/\//i.test(remote)) {
    try {
      return new URL(remote).hostname || null;
    } catch {
      return null;
    }
  }
  return scp?.[1] ?? null;
}

const SUMMARY_CHARS = 600;
const DRAFT_COMMITS = 30;

/**
 * A pull request's title and description, written without a model: the title from the
 * thread (or its first commit), a short summary from the first message, and the commit list.
 */
export function draftPullRequest(o: { title: string; firstMessage: string; commits: string[]; files: number; branch: string }): PullRequestDraft {
  const commits = o.commits.filter(
    (c, i, all) => c.trim() && !/^Merge (branch |remote-tracking branch |origin\/|refs\/)?\S+ into /.test(c) && c !== all[i - 1],
  );
  const title = (o.title.trim() || (o.firstMessage.trim() ? commitSubject(o.firstMessage) : "") || commits[0] || "Changes from LemonLime").slice(0, 200);
  const summary = summarise(o.firstMessage);
  const list = commits.slice(0, DRAFT_COMMITS).map(c => `- ${c}`);
  if (commits.length > DRAFT_COMMITS) list.push(`- …and ${commits.length - DRAFT_COMMITS} more`);
  const counts = `${o.files} ${o.files === 1 ? "file" : "files"} changed in ${commits.length} ${commits.length === 1 ? "commit" : "commits"}.`;
  const parts = [
    summary ? `## Summary\n\n${summary}` : "",
    list.length ? `## Changes\n\n${list.join("\n")}\n\n${counts}` : "",
    `Made with LemonLime on \`${o.branch}\`.`,
  ];
  return { title, body: parts.filter(Boolean).join("\n\n") };
}

/** The first paragraph of a message, on one line, cut at a sentence end when it's long. */
function summarise(text: string): string {
  const para = (text.trim().split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  if (para.length <= SUMMARY_CHARS) return para;
  const cut = para.slice(0, SUMMARY_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > SUMMARY_CHARS / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** `gh pr view` (state, mergeable, checks, comments, reviews) and the inline review comments → a watch snapshot. */
export function parseWatchSnapshot(view: unknown, inline: unknown): WatchSnapshot | null {
  if (!view || typeof view !== "object") return null;
  const v = view as {
    number?: unknown;
    state?: unknown;
    mergeable?: unknown;
    headRefOid?: unknown;
    statusCheckRollup?: unknown;
    comments?: unknown;
    reviews?: unknown;
  };
  if (typeof v.number !== "number") return null;
  const state = String(v.state ?? "").toUpperCase() === "MERGED" ? "merged" : String(v.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open";
  const rollup = Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [];
  const comments: WatchSnapshot["comments"] = [];
  const login = (a: unknown) => String((a as { login?: unknown } | null)?.login ?? "someone");
  for (const c of Array.isArray(v.comments) ? v.comments : []) {
    const x = c as { id?: unknown; author?: unknown; body?: unknown; createdAt?: unknown };
    if (x.id === undefined) continue;
    comments.push({ id: `c:${String(x.id)}`, author: login(x.author), body: String(x.body ?? ""), at: String(x.createdAt ?? "") });
  }
  for (const r of Array.isArray(v.reviews) ? v.reviews : []) {
    const x = r as { id?: unknown; author?: unknown; body?: unknown; state?: unknown; submittedAt?: unknown };
    // A plain approval with nothing written isn't something to act on.
    if (x.id === undefined || (!String(x.body ?? "").trim() && String(x.state ?? "").toUpperCase() !== "CHANGES_REQUESTED")) continue;
    const asked = String(x.state ?? "").toUpperCase() === "CHANGES_REQUESTED";
    comments.push({
      id: `r:${String(x.id)}`,
      author: login(x.author),
      body: String(x.body ?? "").trim() || (asked ? "(asked for changes)" : ""),
      at: String(x.submittedAt ?? ""),
    });
  }
  for (const c of Array.isArray(inline) ? inline : []) {
    const x = c as { id?: unknown; user?: unknown; body?: unknown; path?: unknown; line?: unknown; created_at?: unknown };
    if (x.id === undefined) continue;
    const where = typeof x.path === "string" ? `${x.path}${typeof x.line === "number" ? `:${x.line}` : ""}` : undefined;
    comments.push({
      id: `i:${String(x.id)}`,
      author: login(x.user),
      body: String(x.body ?? ""),
      at: String(x.created_at ?? ""),
      ...(where ? { path: where } : {}),
    });
  }
  return {
    number: v.number,
    state,
    headSha: String(v.headRefOid ?? ""),
    checks: rollupChecks(rollup),
    failing: failingChecks(rollup),
    conflicting: String(v.mergeable ?? "").toUpperCase() === "CONFLICTING",
    comments,
  };
}

/** Names of the failed checks in a `statusCheckRollup`. */
export function failingChecks(rollup: unknown[]): string[] {
  const out: string[] = [];
  for (const item of rollup) {
    const c = (item ?? {}) as { name?: string; context?: string; conclusion?: string; state?: string };
    const conclusion = (c.conclusion ?? "").toUpperCase();
    const state = (c.state ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) || state === "FAILURE" || state === "ERROR")
      out.push(c.name || c.context || "a check");
  }
  return [...new Set(out)].sort();
}

/** `gh pr view --json url,number,state,isDraft,statusCheckRollup` → what the app shows. */
export function parseGhPullRequest(json: unknown): PullRequestInfo | null {
  if (!json || typeof json !== "object") return null;
  const o = json as { url?: unknown; number?: unknown; state?: unknown; isDraft?: unknown; statusCheckRollup?: unknown };
  if (typeof o.url !== "string") return null;
  const state = String(o.state ?? "").toUpperCase() === "MERGED" ? "merged" : String(o.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open";
  return {
    url: o.url,
    ...(typeof o.number === "number" ? { number: o.number } : {}),
    state,
    draft: o.isDraft === true,
    checks: rollupChecks(Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : []),
  };
}

/** One word for a pull request's checks, from `statusCheckRollup` (check runs and commit statuses). */
export function rollupChecks(rollup: unknown[]): NonNullable<PullRequestInfo["checks"]> {
  if (!rollup.length) return "none";
  let pending = false;
  for (const item of rollup) {
    const c = (item ?? {}) as { status?: string; conclusion?: string; state?: string };
    const conclusion = (c.conclusion ?? "").toUpperCase();
    const state = (c.state ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) || state === "FAILURE" || state === "ERROR")
      return "failing";
    if (c.status !== undefined ? (c.status ?? "").toUpperCase() !== "COMPLETED" : state === "PENDING" || state === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "passing";
}
