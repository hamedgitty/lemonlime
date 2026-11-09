import { SHORTCUTS } from "./shortcuts.ts";

/**
 * Every option in Settings, for Settings search: what it's called, where it lives (page and
 * tab) and the row to bring into view. `anchor` is the row's `data-setting`, which Settings
 * rows take from their label unless they're given one; it defaults to the title.
 */
export interface SettingEntry {
  page: string;
  tab?: string;
  title: string;
  description?: string;
  keywords?: string;
  anchor?: string;
}

const g = (tab: string, title: string, keywords = "", description = "", anchor?: string): SettingEntry => ({
  page: "general",
  tab,
  title,
  ...(keywords ? { keywords } : {}),
  ...(description ? { description } : {}),
  ...(anchor ? { anchor } : {}),
});
const agents = (tab: string, title: string, keywords = "", anchor?: string): SettingEntry => ({
  page: "agents",
  tab,
  title,
  ...(keywords ? { keywords } : {}),
  ...(anchor ? { anchor } : {}),
});
const on = (page: string, title: string, keywords = "", tab?: string, anchor?: string): SettingEntry => ({
  page,
  title,
  ...(tab ? { tab } : {}),
  ...(keywords ? { keywords } : {}),
  ...(anchor ? { anchor } : {}),
});

export const SETTINGS_INDEX: SettingEntry[] = [
  // General
  g("general", "Open new threads right away", "navigate go to thread create"),
  g("general", "Send messages with", "send key enter cmd ctrl command return new line shift multiline"),
  g("general", "While the agent is working, Enter…", "queue steer follow up enter key send"),
  g("general", "Suggest what to say next", "next prompt suggestion reply tab"),
  g("general", "Spot the wrong project", "project hint switch home"),
  g("general", "Rename vague thread titles", "thread names naming title auto rename"),
  g("general", "Open links in the side panel", "browser in-app links web panel"),
  g("general", "Microphone", "voice dictation mic input speech audio"),
  g("general", "Runner", "runner path lemonlime-runner binary"),
  g("notifications", "Notifications", "notify alerts"),
  g("notifications", "When an agent finishes", "notify done finished"),
  g("notifications", "When something fails", "notify error failed"),
  g("notifications", "When an agent needs you", "notify approval question waiting"),
  g("notifications", "Even for the thread I'm looking at", "notify focused"),
  g("awake", "Keep this computer awake while agents work", "sleep caffeinate keep awake"),
  g("awake", "Keep the screen on too", "display screen sleep"),
  g("files", "Open folders in", "editor vs code cursor zed file manager open in editor"),
  g("phone", "Use my local threads from my phone", "phone mobile remote access qr"),
  g("phone", "This computer's name", "computer name phone dashboard"),
  // Account
  on("account", "Sign in with your browser", "sign in login cloud", "account"),
  on("account", "Dashboard address", "control plane url server self-host", "account"),
  on("account", "Access token", "token key keychain", "account"),
  on("account", "Run setup again", "setup wizard onboarding", "account"),
  on("account", "Manage your account", "email billing delete account", "account"),
  on("account", "Work in", "workspace team", "account"),
  on("account", "Your activity", "activity stats usage threads", "activity"),
  // Agents
  agents("harness", "Harness", "install update version agents order auto-update installed"),
  agents("accounts", "Accounts", "sign in accounts plan usage switch"),
  agents("defaults", "Start new threads on", "place cloud local default where"),
  agents("defaults", "Default agent", "agent claude codex opencode"),
  agents("defaults", "Remove AI co-author lines", "coauthor co-authored-by commits trailer"),
  agents("defaults", "Branch names start with", "branch prefix git"),
  agents("defaults", "Offer the highest effort levels", "max reasoning effort ultra"),
  agents("guard", "Block destructive commands", "command guard rm safety dangerous"),
  agents("claude-code", "Claude Code model", "model opus sonnet", "Model"),
  agents("claude-code", "Claude Code effort", "reasoning effort thinking", "Effort"),
  agents("claude-code", "Claude Code fast mode", "fast", "Fast mode"),
  agents("claude-code", "Sign in to Claude Code", "login", "Sign in"),
  agents("codex", "Codex model", "model gpt", "Model"),
  agents("codex", "Codex effort", "reasoning effort thinking", "Effort"),
  agents("codex", "Codex fast mode", "fast", "Fast mode"),
  agents("codex", "Sign in to Codex", "login", "Sign in"),
  agents("acp", "ACP agents", "agent client protocol custom command opencode"),
  agents("retry", "When an agent hits its limit", "usage limit switch account rate limit"),
  agents("retry", "Wait and try again", "retry overloaded busy limit wait"),
  // Instructions
  on("instructions", "Custom instructions", "system prompt agents.md claude.md rules", "custom"),
  on("instructions", "Built-in skills", "skills bundled", "builtin"),
  // Cloud
  on("cloud", "Setup script", "install dependencies sandbox bootstrap", "environment"),
  on("cloud", "Instructions for cloud agents", "system prompt cloud", "environment"),
  on("cloud", "Remove AI co-author lines", "coauthor co-authored-by commits cloud", "environment"),
  on("cloud", "When a limit is hit, wait and try again", "retry cloud limit", "environment"),
  on("cloud", "API keys and secrets", "env environment variables secrets keys", "keys"),
  on("cloud", "Skills for cloud agents", "skills sync cloud", "skills"),
  on("cloud", "Delete unused cloud threads after", "auto delete clean up old sandboxes", "cleanup"),
  // Machines
  on("machines", "Your machines", "ssh remote server dev box tailscale"),
  on("machines", "What the machine needs", "ssh requirements node git"),
  // Projects
  on("projects", "Projects", "folders repositories recent", "projects"),
  on("projects", "Archived threads", "restore unarchive archive", "archived"),
  on("projects", "Export chats", "export markdown json download", "export"),
  // Appearance
  on("appearance", "Colours", "theme dark light system mode"),
  on("appearance", "Sidebar", "show hide nav skills plugins automations search"),
  on("appearance", "Show each thread's agent", "agent icons sidebar"),
  on("appearance", "List subagents under their thread", "subagents children sidebar"),
  on("appearance", "Group threads", "organize project place agent"),
  on("appearance", "Sort threads", "order recent name"),
  on("appearance", "Fold finished turns", "collapse fold timeline"),
  on("appearance", "Dim inactive panes in split view", "split panes fade dim"),
  on("appearance", "Always show one-click prompts", "starters suggestions home prompts"),
  // Keyboard
  on("keyboard", "Show shortcut hints while holding ⌘", "hints overlay cmd ctrl", undefined, "shortcut-hints"),
  ...SHORTCUTS.map(s => on("keyboard", s.label, "shortcut keys keyboard rebind turn off")),
  // Updates
  on("updates", "Updates", "check version update app"),
  on("updates", "Update agents", "agents update npm", undefined, "Agents"),
  on("updates", "Version", "version about"),
];

export const settingAnchor = (e: SettingEntry) => e.anchor ?? e.title;

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

/** The options matching a search, best first: every word must appear in the title, description or keywords. */
export function findSettings(query: string, index: readonly SettingEntry[] = SETTINGS_INDEX): SettingEntry[] {
  const q = words(query);
  if (!q.length) return [];
  const scored: { e: SettingEntry; score: number; i: number }[] = [];
  index.forEach((e, i) => {
    const title = e.title.toLowerCase();
    const hay = `${title} ${(e.description ?? "").toLowerCase()} ${(e.keywords ?? "").toLowerCase()}`;
    if (!q.every(w => hay.includes(w))) return;
    const phrase = q.join(" ");
    const score = title.startsWith(phrase) ? 3 : title.includes(phrase) ? 2 : q.every(w => title.includes(w)) ? 1 : 0;
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(s => s.e);
}

/** Matches grouped by page, in the pages' order (pages with no match are left out). */
export function groupByPage(matches: readonly SettingEntry[], pageOrder: readonly string[]): { page: string; entries: SettingEntry[] }[] {
  return pageOrder.map(page => ({ page, entries: matches.filter(m => m.page === page) })).filter(gr => gr.entries.length > 0);
}
