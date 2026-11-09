import { invoke, isTauri } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { BranchList, PullRequestLookup, type AgentKind } from "@lemonlime/protocol";

/** Thin wrappers around the Rust commands in src-tauri/src/runner.rs. */

export const inDesktopShell = (): boolean => isTauri();

export interface LocalRunnerInfo {
  port: number;
  secret: string;
}

export interface StartLocalRunnerArgs {
  threadId: string;
  agent: AgentKind;
  agentCommand?: string | undefined;
  model?: string | undefined;
  reasoning?: string | undefined;
  /** Start in the agent's fast mode (--fast). */
  fast?: boolean | undefined;
  workdir: string;
  baseBranch?: string | undefined;
  /** Path to lemonlime-runner, or empty to look it up on PATH. */
  runnerPath?: string | undefined;
  /** The user's own instructions, added to every turn (saved to a file for --instructions-file). */
  instructions?: string | undefined;
  /** Remove Co-authored-by trailers from the agent's commits (--strip-coauthors). */
  stripCoauthors?: boolean | undefined;
  /** Branch name prefix for new threads, e.g. "agent/" (--branch-prefix). Existing threads keep theirs. */
  branchPrefix?: string | undefined;
  /** Retry turns that hit a busy provider or a usage limit, waiting at most this long (--retry-max-wait); 0 or unset: off. */
  retryMaxWaitMinutes?: number | undefined;
  /** Bundled skills to leave out (--disable-skills). */
  disabledSkills?: string[] | undefined;
  /** false turns the command guard off (--no-command-guard). On when unset. */
  commandGuard?: boolean | undefined;
  /** Work on this existing branch instead of a new one (--branch). */
  threadBranch?: string | undefined;
  /** With threadBranch: it's this pull request's branch (--pull-request). */
  pullRequest?: number | undefined;
  /** Start the new branch from this commit or branch instead of the base (--start-from). */
  startFrom?: string | undefined;
}

function requireShell(): void {
  if (!isTauri()) throw new Error("Local threads need the LemonLime desktop app. Start it with `pnpm tauri dev`.");
}

type RunnerDefaults = Pick<
  StartLocalRunnerArgs,
  "instructions" | "stripCoauthors" | "branchPrefix" | "retryMaxWaitMinutes" | "disabledSkills" | "commandGuard"
>;
let runnerDefaults: RunnerDefaults = {};

/** What every local runner starts with, from Settings (the app keeps it current). */
export function setRunnerDefaults(d: RunnerDefaults): void {
  runnerDefaults = d;
}

/** Starts (or returns the already running) runner for a local thread. */
export async function startLocalRunner(input: StartLocalRunnerArgs): Promise<LocalRunnerInfo> {
  requireShell();
  const args: StartLocalRunnerArgs = { ...runnerDefaults, ...input };
  return invoke<LocalRunnerInfo>("start_local_runner", {
    threadId: args.threadId,
    agent: args.agent,
    agentCommand: args.agentCommand || null,
    model: args.model || null,
    reasoning: args.reasoning || null,
    fast: args.fast ?? null,
    workdir: args.workdir,
    baseBranch: args.baseBranch || null,
    runnerPath: args.runnerPath || null,
    instructions: args.instructions?.trim() ? args.instructions : null,
    stripCoauthors: args.stripCoauthors ?? null,
    branchPrefix: args.branchPrefix || null,
    retryMaxWaitMinutes: args.retryMaxWaitMinutes ?? null,
    disabledSkills: args.disabledSkills?.length ? args.disabledSkills : null,
    commandGuard: args.commandGuard ?? null,
    threadBranch: args.threadBranch || null,
    startFrom: args.startFrom || null,
    pullRequest: args.pullRequest ?? null,
  });
}

/** Starts (or returns the already running) runner for a thread on another machine, over SSH (src-tauri/src/ssh.rs). */
export async function startSshRunner(input: StartLocalRunnerArgs & { host: string; remoteRunnerPath?: string | undefined }): Promise<LocalRunnerInfo> {
  requireShell();
  const args = { ...runnerDefaults, ...input };
  return invoke<LocalRunnerInfo>("start_ssh_runner", {
    threadId: args.threadId,
    host: args.host,
    runnerPath: args.remoteRunnerPath || null,
    agent: args.agent,
    agentCommand: args.agentCommand || null,
    model: args.model || null,
    reasoning: args.reasoning || null,
    fast: args.fast ?? null,
    workdir: args.workdir,
    baseBranch: args.baseBranch || null,
    instructions: args.instructions?.trim() ? args.instructions : null,
    stripCoauthors: args.stripCoauthors ?? null,
    branchPrefix: args.branchPrefix || null,
    retryMaxWaitMinutes: args.retryMaxWaitMinutes ?? null,
    disabledSkills: args.disabledSkills?.length ? args.disabledSkills : null,
    commandGuard: args.commandGuard ?? null,
    threadBranch: args.threadBranch || null,
    startFrom: args.startFrom || null,
    pullRequest: args.pullRequest ?? null,
  });
}

export interface SshCheck {
  ok: boolean;
  version: string | null;
  /** What happened, in plain words. */
  message: string;
}

/** Logs in to a machine without prompting and asks its runner for its version. */
export async function checkSshMachine(host: string, runnerPath: string): Promise<SshCheck> {
  requireShell();
  return invoke<SshCheck>("check_ssh_machine", { host, runnerPath: runnerPath || null });
}

/** Stops a thread on another machine and removes its worktree and history there; the branch stays. */
export async function removeSshThread(threadId: string, host: string, runnerPath: string, workdir: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("remove_ssh_thread", { threadId, host, runnerPath: runnerPath || null, workdir });
}

export async function stopLocalRunner(threadId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_local_runner", { threadId });
}

/**
 * Stops a local thread and removes its worktree and local history. The thread's
 * branch and commits stay in the repository.
 */
export async function removeLocalThread(threadId: string, repoPath: string, runnerPath?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("remove_local_thread", { threadId, repoPath, runnerPath: runnerPath || null });
}

/** True while the runner process for this thread is alive. */
export async function isLocalRunnerRunning(threadId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("local_runner_running", { threadId });
}

/** Ids of every thread whose runner is alive. */
export async function listLocalRunners(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("list_local_runners");
}

export interface RepoInfo {
  /** Current branch, or null for a detached HEAD. */
  branch: string | null;
  /** The `origin` remote's URL, or null. */
  origin: string | null;
}

/** Checks that a folder is a git repository and returns its current branch. */
export async function inspectRepo(path: string): Promise<RepoInfo> {
  requireShell();
  return invoke<RepoInfo>("inspect_repo", { path });
}

/** The repository's branches, local and on origin, newest first. */
export async function listBranches(repoPath: string, runnerPath?: string): Promise<BranchList> {
  requireShell();
  return BranchList.parse(await invoke("list_branches", { repoPath, runnerPath: runnerPath || null }));
}

/** A pull request of the repository, from a link or `#123` (needs the GitHub CLI). */
export async function lookupPullRequest(repoPath: string, reference: string, runnerPath?: string): Promise<PullRequestLookup> {
  requireShell();
  return PullRequestLookup.parse(await invoke("lookup_pull_request", { repoPath, reference, runnerPath: runnerPath || null }));
}

/** Removes a stopped thread's worktree; its history and branch stay. Refused with uncommitted changes. */
export async function removeThreadWorktree(threadId: string, repoPath: string, runnerPath?: string): Promise<void> {
  requireShell();
  await invoke("remove_thread_worktree", { threadId, repoPath, runnerPath: runnerPath || null });
}

/** Opens the system folder picker. Returns null if the user cancels. */
export async function pickFolder(): Promise<string | null> {
  requireShell();
  const picked = await open({ directory: true, multiple: false, title: "Choose a repository" });
  return typeof picked === "string" ? picked : null;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** LemonLime's own, yours, or one an agent keeps for itself on this computer. */
  source: "bundled" | "yours" | "claude-code" | "codex" | "opencode" | "shared";
}

/** LemonLime's own skills and the user's, as copied into every local thread. */
export async function listSkills(): Promise<SkillInfo[]> {
  if (!isTauri()) return [];
  return invoke<SkillInfo[]>("list_skills");
}

/** Asks for a skill folder and adds it. Null if the user cancels. */
export async function addSkillFromFolder(): Promise<string | null> {
  requireShell();
  const picked = await open({ directory: true, multiple: false, title: "Choose a skill folder (one with a SKILL.md)" });
  if (typeof picked !== "string") return null;
  return invoke<string>("add_skill", { path: picked });
}

export async function removeSkill(name: string): Promise<void> {
  requireShell();
  await invoke("remove_skill", { name });
}

/** The folder the user's skills live in (created if missing). */
export async function skillsFolder(): Promise<string> {
  requireShell();
  return invoke<string>("skills_folder");
}

/** Open a cloud preview on 127.0.0.1 through the runner; returns the local port. */
export async function startPreviewTunnel(runnerUrl: string, port: number, token: string, runnerPath?: string): Promise<number> {
  requireShell();
  return invoke<number>("start_preview_tunnel", { runnerUrl, port, token, runnerPath: runnerPath || null });
}

export async function previewTunnelToken(runnerUrl: string, port: number, token: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("preview_tunnel_token", { runnerUrl, port, token });
}

export async function stopPreviewTunnel(runnerUrl: string, port: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_preview_tunnel", { runnerUrl, port });
}

/** Asks a yes/no question with the native dialog (or the browser's when not in the shell). */
export async function confirmAction(message: string): Promise<boolean> {
  if (isTauri()) return ask(message, { title: "LemonLime", kind: "warning" });
  return window.confirm(message);
}

const TOKEN_SECRET = "control-plane-token";
const BROWSER_TOKEN_KEY = "lemonlime:dev-token";

/**
 * The control plane access token lives in the OS keychain in the desktop app. In a plain
 * browser (development preview) it falls back to local storage.
 */
export async function loadAccessToken(): Promise<string> {
  if (!isTauri()) {
    try {
      return localStorage.getItem(BROWSER_TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  }
  return (await invoke<string | null>("secret_get", { name: TOKEN_SECRET })) ?? "";
}

export async function saveAccessToken(token: string): Promise<void> {
  if (!isTauri()) {
    try {
      if (token) localStorage.setItem(BROWSER_TOKEN_KEY, token);
      else localStorage.removeItem(BROWSER_TOKEN_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  await invoke("secret_set", { name: TOKEN_SECRET, value: token });
}
