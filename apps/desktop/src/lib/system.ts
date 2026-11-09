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
  /** Installed with npm, so LemonLime can update it (older apps leave it out). */
  viaNpm?: boolean;
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

/** The text `opencode models --verbose` prints (see parseOpencodeModels). */
export async function opencodeModelsText(): Promise<string> {
  if (!isTauri()) throw new Error("Listing OpenCode's models works in the desktop app.");
  return invoke<string>("agent_models", { kind: "opencode" });
}

/** Signs an agent out on this computer with its own command (Claude Code and Codex). */
export async function signOutAgent(kind: Exclude<AgentKind, "acp">): Promise<void> {
  await invoke("sign_out_agent", { kind });
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
  health: {
    status?: ThreadStatus;
    latestSeq?: number;
    idleSince?: string | null;
    waitingApprovals?: number;
    /** The agent and account the thread uses now (runners from before accounts leave them out). */
    agent?: AgentKind;
    account?: string | null;
    /** The usage limit it's stopped on, if any. */
    limit?: { agent: AgentKind; account: string | null; resetAt: string | null } | null;
  };
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

/** The thread a notification is about: clicking it opens that thread. */
export interface NotifyTarget {
  threadId: string;
  mode: "local" | "cloud";
}

/** A notification's number for a thread (32-bit, as the OS wants), so it can be closed later. */
export function notificationId(threadId: string): number {
  // FNV-1a, kept positive and never 0.
  let h = 0x811c9dc5;
  for (let i = 0; i < threadId.length; i++) {
    h ^= threadId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 1 || 1;
}

/** The thread a clicked notification was about, from what it carried. */
export function notifyTargetOf(extra: unknown): NotifyTarget | null {
  if (!extra || typeof extra !== "object") return null;
  const { threadId, mode } = extra as Record<string, unknown>;
  if (typeof threadId !== "string" || !threadId || (mode !== "local" && mode !== "cloud")) return null;
  return { threadId, mode };
}

/** Threads with a notification on screen (or in the notification centre), by its number. */
const shown = new Map<string, number>();

/**
 * Shows a system notification. With a `target`, clicking it opens that thread (see
 * `onNotificationClick`, which has to be listening before it's sent).
 */
export async function notify(title: string, body: string, target?: NotifyTarget): Promise<boolean> {
  if (!isTauri()) return false;
  if (permission === null) await notificationPermission(true);
  if (!permission) return false;
  const n = await import("@tauri-apps/plugin-notification");
  if (target) {
    const id = notificationId(target.threadId);
    shown.set(target.threadId, id);
    n.sendNotification({ id, title, body, extra: { threadId: target.threadId, mode: target.mode } });
  } else n.sendNotification({ title, body });
  return true;
}

/**
 * Calls `onOpen` when a notification about a thread is clicked. The OS reports clicks only
 * for notifications sent while this listens, so start it when the app starts.
 */
export async function onNotificationClick(onOpen: (target: NotifyTarget) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const n = await import("@tauri-apps/plugin-notification");
  const listener = await n.onAction(e => {
    const target = notifyTargetOf(e.notification?.extra);
    if (target && e.actionId === "tap") onOpen(target);
  });
  return () => void listener.unregister().catch(() => undefined);
}

/** Brings the app's window to the front (after a notification was clicked). */
export async function focusAppWindow(): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  await w.unminimize().catch(() => undefined);
  await w.show().catch(() => undefined);
  await w.setFocus().catch(() => undefined);
}

/** A thread was looked at: its notification has said its piece (closed where the OS allows it). */
export async function closeThreadNotifications(threadId: string): Promise<void> {
  const id = shown.get(threadId);
  if (id === undefined || !isTauri()) return;
  shown.delete(threadId);
  const n = await import("@tauri-apps/plugin-notification");
  await n.removeActive([{ id }]).catch(() => undefined);
}

/** Your skills' text files, for syncing to the cloud. */
export async function exportSkills(names: string[]): Promise<{ name: string; files: Record<string, string> }[]> {
  return invoke("export_skills", { names });
}

/**
 * Asks where to save (a native dialog the app shows itself), then writes the text there.
 * False if the person cancelled.
 */
export async function saveTextFile(defaultName: string, content: string, filter: { name: string; extensions: string[] }): Promise<boolean> {
  return invoke<boolean>("save_text_file", { defaultName, content, filterName: filter.name, extensions: filter.extensions });
}

/**
 * The folder a local thread works in: its own git worktree, where the runner puts it
 * (~/.lemonlime/worktrees/<repo>-<hash>/<thread>, see worktreePathFor in the runner).
 */
export async function threadFolder(repoPath: string, threadId: string): Promise<string> {
  const { homeDir, join } = await import("@tauri-apps/api/path");
  const name = (repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repoPath.replace(/[\\/]+$/, "")));
  const hash = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
  return join(await homeDir(), ".lemonlime", "worktrees", `${name}-${hash}`, threadId);
}

/** Opens a folder in the chosen editor, or the file manager when none is chosen. */
export async function openFolder(path: string, editor: string): Promise<void> {
  if (editor) return openInEditor(editor, path);
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}
