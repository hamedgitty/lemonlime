import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Agent plugins: thin wrappers around the Rust commands in src-tauri/src/plugins.rs, plus
 * the small pure helpers the Plugins page uses. A plugin bundles skills, slash commands,
 * subagents and MCP servers for coding agents; see docs/plugins.md.
 */

/** What a plugin gives the agents. */
export interface PluginContents {
  skills: string[];
  /** e.g. "review" or, for one in a subfolder, "git/commit". */
  commands: string[];
  agents: string[];
  mcpServers: string[];
  /** Hook events it defines. LemonLime never runs them. */
  hooks: string[];
  hooksApplied: boolean;
}

export interface PluginSummary {
  name: string;
  description: string;
  version: string | null;
  author: string | null;
  homepage: string | null;
  /** An https git URL or a local folder path. */
  source: string;
  sourceKind: "git" | "folder";
  /** The branch or tag it follows, if one was asked for. */
  ref: string | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  commit: string | null;
  contents: PluginContents;
  /** Set when the installed copy can't be read any more. */
  problem: string | null;
}

export interface PluginDetail extends PluginSummary {
  license: string | null;
  readme: string | null;
}

export interface PluginInstallResult {
  installed: PluginSummary[];
  /** Plugins a marketplace listed that weren't installed, and why. */
  skipped: string[];
}

export interface PluginUpdateResult {
  name: string;
  previousVersion: string | null;
  version: string | null;
  previousCommit: string | null;
  commit: string | null;
  /** False when it was already up to date. */
  changed: boolean;
}

export interface PluginUpdateCheck {
  name: string;
  latestCommit: string | null;
  hasUpdate: boolean;
  error: string | null;
}

function requireShell(): void {
  if (!isTauri()) throw new Error("Plugins need the LemonLime desktop app.");
}

/** Every installed plugin, on or off. Empty outside the desktop app. */
export async function listPlugins(): Promise<PluginSummary[]> {
  if (!isTauri()) return [];
  return invoke<PluginSummary[]>("list_plugins");
}

/** One plugin with its README. */
export async function readPlugin(name: string): Promise<PluginDetail> {
  requireShell();
  return invoke<PluginDetail>("read_plugin", { name });
}

/**
 * Clone an https repository (a plugin or a marketplace of them) and install what it holds.
 * With `plugin`, install just that plugin from a marketplace, even one kept in another repository.
 */
export async function installPluginFromGit(url: string, ref?: string, plugin?: string): Promise<PluginInstallResult> {
  requireShell();
  return invoke<PluginInstallResult>("install_plugin_from_git", { url: url.trim(), gitRef: ref?.trim() || null, plugin: plugin?.trim() || null });
}

/** Install from a folder on this computer. */
export async function installPluginFromFolder(path: string): Promise<PluginInstallResult> {
  requireShell();
  return invoke<PluginInstallResult>("install_plugin_from_folder", { path });
}

/** Ask for a plugin folder. Null if the user cancels. */
export async function pickPluginFolder(): Promise<string | null> {
  requireShell();
  const picked = await open({ directory: true, multiple: false, title: "Choose a plugin folder (one with .claude-plugin/plugin.json)" });
  return typeof picked === "string" ? picked : null;
}

export async function setPluginEnabled(name: string, enabled: boolean): Promise<void> {
  requireShell();
  await invoke("set_plugin_enabled", { name, enabled });
}

/** Fetch the plugin's source again and use the newest version. */
export async function updatePlugin(name: string): Promise<PluginUpdateResult> {
  requireShell();
  return invoke<PluginUpdateResult>("update_plugin", { name });
}

export async function removePlugin(name: string): Promise<void> {
  requireShell();
  await invoke("remove_plugin", { name });
}

/** Ask each git plugin's repository whether it has a newer commit (nothing is downloaded). */
export async function checkPluginUpdates(): Promise<PluginUpdateCheck[]> {
  if (!isTauri()) return [];
  return invoke<PluginUpdateCheck[]>("check_plugin_updates");
}

/** The folder plugins live in (created if missing). */
export async function pluginsFolder(): Promise<string> {
  requireShell();
  return invoke<string>("plugins_folder");
}

// ---------------------------------------------------------------------------------------
// Pure helpers

export type PluginTab = "all" | "installed" | "updates";

/** Why a git URL won't be accepted, or null if it looks fine (the app checks again). */
export function gitUrlProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return "Paste a link to the repository.";
  if (!/^https:\/\//i.test(u)) return "Use an https:// link to the repository.";
  if (/\s/.test(u)) return "That link has spaces in it.";
  const host = u.slice(8).split("/")[0] ?? "";
  if (host.includes("@")) return "Leave sign-in details out of the link; git asks for them if the repository is private.";
  if (!host || u.slice(8 + host.length).replace(/\/+$/, "") === "") return "That link has no repository path.";
  return null;
}

/** Plugins matching a search, on a tab. `updates` holds the names with a newer version. */
export function filterPlugins(list: PluginSummary[], query: string, tab: PluginTab, updates: ReadonlySet<string>): PluginSummary[] {
  const q = query.trim().toLowerCase();
  return list.filter(p => {
    if (tab === "updates" && !updates.has(p.name)) return false;
    if (!q) return true;
    const c = p.contents;
    return [p.name, p.description, p.author ?? "", ...c.skills, ...c.commands, ...c.agents, ...c.mcpServers].some(s => s.toLowerCase().includes(q));
  });
}

/** The letter shown in a plugin's tile. */
export function pluginInitial(name: string): string {
  return (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
}

/** "3 skills, 2 commands and 1 MCP server", or "Nothing yet" for an empty plugin. */
export function contentsSummary(c: PluginContents): string {
  const parts = [
    [c.skills.length, "skill", "skills"],
    [c.commands.length, "command", "commands"],
    [c.agents.length, "subagent", "subagents"],
    [c.mcpServers.length, "MCP server", "MCP servers"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (parts.length === 0) return c.hooks.length ? "Only hooks, which LemonLime doesn't run" : "Nothing agents can use yet";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The prompt behind the "Create a plugin with an agent" example. */
export const CREATE_PLUGIN_PROMPT = `Create an agent plugin in a new folder called my-plugin, in the standard layout:

- .claude-plugin/plugin.json with name, description, version and author
- skills/<skill-name>/SKILL.md for each skill (front matter with name and a description that says when to use it)
- commands/<command>.md for slash commands
- agents/<agent>.md for subagents (front matter with name and description)
- .mcp.json if it needs MCP servers
- a README.md that explains what it does

Ask me what the plugin should help with before you start. Keep every path inside the folder and don't use symbolic links.`;
