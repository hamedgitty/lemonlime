import { invoke, isTauri } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import type { AgentKind } from "@lemonlime/protocol";

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
  workdir: string;
  baseBranch?: string | undefined;
  /** Path to lemonlime-runner, or empty to look it up on PATH. */
  runnerPath?: string | undefined;
}

function requireShell(): void {
  if (!isTauri()) throw new Error("Local threads need the LemonLime desktop app. Start it with `pnpm tauri dev`.");
}

/** Starts (or returns the already running) runner for a local thread. */
export async function startLocalRunner(args: StartLocalRunnerArgs): Promise<LocalRunnerInfo> {
  requireShell();
  return invoke<LocalRunnerInfo>("start_local_runner", {
    threadId: args.threadId,
    agent: args.agent,
    agentCommand: args.agentCommand || null,
    model: args.model || null,
    reasoning: args.reasoning || null,
    workdir: args.workdir,
    baseBranch: args.baseBranch || null,
    runnerPath: args.runnerPath || null,
  });
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

/** Opens the system folder picker. Returns null if the user cancels. */
export async function pickFolder(): Promise<string | null> {
  requireShell();
  const picked = await open({ directory: true, multiple: false, title: "Choose a repository" });
  return typeof picked === "string" ? picked : null;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "bundled" | "yours";
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
