import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AgentKind, ThreadStatus } from "@lemonlime/protocol";

/** Wrappers around src-tauri/src/system.rs and the skill preview commands. */

export interface AgentInstall {
  kind: Exclude<AgentKind, "acp">;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Null when it can't be told without reading a credential. */
  signedIn: boolean | null;
}

/** Agent CLI versions LemonLime is tested with (kept in step with the runner's TESTED_AGENTS). */
export const TESTED_AGENTS: { kind: Exclude<AgentKind, "acp">; version: string; signIn: string }[] = [
  { kind: "claude-code", version: "2.1.302", signIn: "claude auth login" },
  { kind: "codex", version: "0.167.0", signIn: "codex login" },
  { kind: "opencode", version: "1.18.18", signIn: "opencode auth login" },
];

/** -1, 0 or 1, comparing dotted versions numerically ("2.1.10" > "2.1.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function detectAgents(): Promise<AgentInstall[]> {
  if (!isTauri()) return [];
  return invoke<AgentInstall[]>("detect_agents");
}

/** Installs or updates an agent CLI with npm. Resolves with npm's output. */
export async function installAgent(kind: Exclude<AgentKind, "acp">): Promise<string> {
  return invoke<string>("install_agent", { kind });
}

/** Keeps the computer awake (and the screen on, with `display`) or lets it sleep. */
export async function setKeepAwake(on: boolean, display: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_keep_awake", { on, display });
}

export interface EditorInfo {
  id: string;
  name: string;
}

export async function listEditors(): Promise<EditorInfo[]> {
  if (!isTauri()) return [];
  return invoke<EditorInfo[]>("list_editors");
}

export async function openInEditor(editor: string, path: string): Promise<void> {
  await invoke("open_in_editor", { editor, path });
}

export interface LocalRunnerStatus {
  threadId: string;
  health: { status?: ThreadStatus; latestSeq?: number; idleSince?: string | null; waitingApprovals?: number };
}

/** What each runner on this computer is doing, including threads that aren't open. */
export async function localRunnerStatuses(): Promise<LocalRunnerStatus[]> {
  if (!isTauri()) return [];
  return invoke<LocalRunnerStatus[]>("local_runner_statuses");
}

export type SkillSource = "bundled" | "yours" | "claude-code" | "codex" | "opencode" | "shared";

export interface SkillDetail {
  name: string;
  path: string;
  content: string;
  files: string[];
}

export async function readSkill(name: string, source: SkillSource): Promise<SkillDetail> {
  return invoke<SkillDetail>("read_skill", { name, source });
}

/** Copies a bundled or agent skill into yours. Returns the new skill's name. */
export async function forkSkill(name: string, source: SkillSource, asName?: string): Promise<string> {
  return invoke<string>("fork_skill", { name, source, asName: asName || null });
}

// ── Notifications ────────────────────────────────────────────

let permission: boolean | null = null;

/** Whether the OS lets LemonLime show notifications; asks once if it hasn't been asked. */
export async function notificationPermission(ask = false): Promise<"granted" | "denied" | "unknown"> {
  if (!isTauri()) return "unknown";
  const n = await import("@tauri-apps/plugin-notification");
  let ok = await n.isPermissionGranted();
  if (!ok && ask) ok = (await n.requestPermission()) === "granted";
  permission = ok;
  return ok ? "granted" : "denied";
}

export async function notify(title: string, body: string): Promise<boolean> {
  if (!isTauri()) return false;
  if (permission === null) await notificationPermission(true);
  if (!permission) return false;
  const n = await import("@tauri-apps/plugin-notification");
  n.sendNotification({ title, body });
  return true;
}

/** Your skills' text files, for syncing to the cloud. */
export async function exportSkills(names: string[]): Promise<{ name: string; files: Record<string, string> }[]> {
  return invoke("export_skills", { names });
}

/** Asks where to save, then writes the text there. False if the person cancelled. */
export async function saveTextFile(defaultName: string, content: string, filter: { name: string; extensions: string[] }): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: defaultName, filters: [filter] });
  if (!path) return false;
  await invoke("save_text_file", { path, content });
  return true;
}
