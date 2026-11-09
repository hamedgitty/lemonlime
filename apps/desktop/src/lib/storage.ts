import { z } from "zod";
import { AgentConfig, ThreadEvent, ThreadId, ThreadStatus } from "@lemonlime/protocol";

/**
 * Everything the app keeps between launches lives in localStorage:
 * settings, local thread metadata, and a cache of each thread's events so the
 * timeline shows instantly and the client only asks the runner for newer ones.
 */

const KEY_SETTINGS = "lemonlime:settings";
const KEY_LOCAL_THREADS = "lemonlime:local-threads";
const eventsKey = (threadId: string) => `lemonlime:events:${threadId}`;

export const Settings = z.object({
  /** Path to the lemonlime-runner binary. Empty means "look it up on PATH". */
  runnerPath: z.string().default(""),
  /** Control plane base URL for cloud threads, e.g. http://localhost:3000. Empty disables cloud threads. */
  controlPlaneUrl: z.string().default(""),
  /** Personal access token for the control plane. */
  accessToken: z.string().default(""),
  /** Which of the account's workspaces cloud threads live in. Empty means the personal one. */
  cloudWorkspaceId: z.string().default(""),
  /** Added to every agent turn on this computer, for every agent. */
  instructions: z.string().max(32_000).default(""),
  /** Remove "Co-authored-by" lines agents add to their commits. */
  stripCoauthors: z.boolean().default(true),
  /** Branch names for new local threads start with this. */
  branchPrefix: z.string().default("agent/"),
  /** When a provider is overloaded or a usage limit is hit, wait up to this long and try again (0 = don't). */
  retryMaxWaitMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(360),
  /** Bundled skills left out of new threads, by name. */
  disabledSkills: z.array(z.string()).default([]),
  /** Block commands that would wipe your home folder or disk, delete hosted repos, and the like. */
  commandGuard: z.boolean().default(true),
  /** ACP agents saved for the agent picker. */
  acpAgents: z.array(z.object({ id: z.string(), name: z.string(), command: z.string() })).default([]),
});
export type Settings = z.infer<typeof Settings>;

export const LocalThreadMeta = z.object({
  id: ThreadId,
  title: z.string().default(""),
  agent: AgentConfig,
  repoPath: z.string(),
  /** Set for a thread on another machine (Settings → Machines), over SSH; repoPath is then a path there. */
  machine: z.string().optional(),
  baseBranch: z.string().default("main"),
  branch: z.string(),
  /** Last status the runner reported. */
  status: ThreadStatus.default("idle"),
  /** Highest event seq this app has stored for the thread. */
  lastSeq: z.number().int().nonnegative().default(0),
  /** First prompt, sent once the runner is connected, then cleared. */
  pendingPrompt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocalThreadMeta = z.infer<typeof LocalThreadMeta>;

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSettings(): Settings {
  const r = Settings.safeParse(read(KEY_SETTINGS) ?? {});
  return r.success ? r.data : Settings.parse({});
}

/** Settings go to local storage, except the access token, which is kept in the keychain. */
export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, { ...s, accessToken: "" });
}

export function loadLocalThreads(): LocalThreadMeta[] {
  const r = z.array(z.unknown()).safeParse(read(KEY_LOCAL_THREADS));
  if (!r.success) return [];
  const out: LocalThreadMeta[] = [];
  for (const item of r.data) {
    const t = LocalThreadMeta.safeParse(item);
    if (t.success) out.push(t.data);
  }
  return out;
}

export function saveLocalThreads(threads: readonly LocalThreadMeta[]): void {
  write(KEY_LOCAL_THREADS, threads);
}

export function loadEvents(threadId: string): ThreadEvent[] {
  const r = z.array(z.unknown()).safeParse(read(eventsKey(threadId)));
  if (!r.success) return [];
  const out: ThreadEvent[] = [];
  for (const item of r.data) {
    const e = ThreadEvent.safeParse(item);
    if (e.success) out.push(e.data);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Stores a thread's events. If storage is full the cache is dropped; the next
 * connection then replays the full history from the runner instead.
 */
export function saveEvents(threadId: string, events: readonly ThreadEvent[]): void {
  if (!write(eventsKey(threadId), events)) {
    try {
      localStorage.removeItem(eventsKey(threadId));
    } catch {
      /* ignore */
    }
  }
}

export function forgetEvents(threadId: string): void {
  try {
    localStorage.removeItem(eventsKey(threadId));
  } catch {
    /* ignore */
  }
}

// ── UI preferences (per computer) ─────────────────────────────

const KEY_UI = "lemonlime:ui";

const AgentKindPref = z.enum(["claude-code", "codex", "opencode", "acp"]);
export const AgentChoice = z.object({
  model: z.string().nullable().catch(null).default(null),
  reasoning: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).nullable().catch(null).default(null),
  fast: z.boolean().catch(false).default(false),
});
export type AgentChoice = z.infer<typeof AgentChoice>;

export const NAV_ITEMS = ["new", "search", "skills", "plugins", "automations"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

export const UiPrefs = z.object({
  /** Sidebar nav items in order; those in `hiddenNav` are not shown. */
  navOrder: z.array(z.enum(NAV_ITEMS)).default([...NAV_ITEMS]),
  hiddenNav: z.array(z.enum(NAV_ITEMS)).default(["search"]),
  organize: z.enum(["project", "place", "agent"]).default("project"),
  sort: z.enum(["recent", "name"]).default("recent"),
  pinned: z.array(z.string()).default([]),
  /** Archived threads, by id, with when (ISO). Out of the list; local ones are cleaned up after 21 days. */
  archived: z.record(z.string(), z.string()).default({}),
  /** The archive explanation has been shown once. */
  archivedHint: z.boolean().default(false),
  /** What each cloud thread's agent may do on this computer (missing = off). */
  computerAccess: z.record(z.string(), z.enum(["off", "read", "ask", "full"])).default({}),
  /** The first-run setup card was finished or put away. */
  setupDone: z.boolean().default(false),
  /** Setup steps ticked by hand (agent signed in). */
  setupAgentSignedIn: z.boolean().default(false),
  sidebarCollapsed: z.boolean().default(false),
  /** Projects (repository folders) used for local threads, most recent first. */
  recentProjects: z.array(z.string()).default([]),
  /** Last agent and place chosen in the composer. */
  lastAgent: z.enum(["claude-code", "codex", "opencode", "acp"]).default("claude-code"),
  lastPlace: z.enum(["local", "cloud"]).default("local"),
  /** With lastPlace "local": the machine (Settings → Machines) last chosen; empty means this computer. */
  lastMachine: z.string().default(""),
  rightPanel: z.boolean().default(false),
  /** Which side the side panel (terminals, browser) sits on. */
  panelSide: z.enum(["left", "right"]).default("right"),
  /** Light, dark, or follow the system. */
  theme: z.enum(["light", "dark", "system"]).default("light"),
  /** Open a thread as soon as it's created. */
  navigateOnCreate: z.boolean().default(true),
  /** What Enter does while the agent is working: queue the message for after the turn, or steer (stop and send now). */
  followUp: z.enum(["queue", "steer"]).default("queue"),
  /** Which key sends a message: Enter, ⌘Enter, or ⌘Enter once the message has more than one line. */
  sendKey: z.enum(["enter", "mod-enter", "mod-enter-multiline"]).catch("enter").default("enter"),
  /** Where new threads start: the last place used, this computer, or the cloud. */
  defaultPlace: z.enum(["last", "local", "cloud"]).default("last"),
  /** Offer the highest reasoning levels in the picker. */
  showMaxReasoning: z.boolean().default(false),
  /** Fold each finished turn into one line in the timeline. */
  collapseFinished: z.boolean().default(false),
  /** Show each thread's agent icon in the sidebar. */
  agentIcons: z.boolean().default(false),
  /** Don't list subagents under their thread in the sidebar (its progress grid stays). */
  collapseChildren: z.boolean().default(false),
  /** Sidebar thread groups folded away, by group key (see sidebarGroups.ts). */
  collapsedGroups: z.array(z.string()).catch([]).default([]),
  /** Sidebar thread groups in the order dragged into, by group key. */
  groupOrder: z.array(z.string()).catch([]).default([]),
  /** In a split, the panes you aren't typing in sit back a little. */
  dimInactivePanes: z.boolean().catch(true).default(true),
  /** Keep the one-click prompts on Home after the first few threads. */
  keepStarterPrompts: z.boolean().catch(false).default(false),
  /** Show which keys do what next to buttons while ⌘ (Ctrl) is held. */
  shortcutHints: z.boolean().catch(true).default(true),
  /** Links in the agent's replies open in the side panel's browser instead of the system browser. */
  openLinksInPanel: z.boolean().catch(false).default(false),
  /** A thread titled from a vague first message ("hi") takes its title from a later one. */
  renameVagueTitles: z.boolean().catch(true).default(true),
  /** The microphone the dictation level meter listens on (a device id); empty is the system default. */
  micDeviceId: z.string().catch("").default(""),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      finished: z.boolean().default(true),
      failed: z.boolean().default(true),
      needsInput: z.boolean().default(true),
      /** Also when the thread is open and the window is in front. */
      whenFocused: z.boolean().default(false),
    })
    .default({ enabled: true, finished: true, failed: true, needsInput: true, whenFocused: false }),
  /** Keep the computer awake while an agent on it is working. */
  keepAwake: z.boolean().default(true),
  /** Keep the screen on as well. */
  keepDisplayOn: z.boolean().default(false),
  /** Editor folders open in (an id from list_editors); empty = the system's file manager. */
  editor: z.string().default(""),
  /** Shortcuts the user changed, by id ("" turns one off). */
  shortcuts: z.record(z.string(), z.string()).default({}),
  /** The last event seq seen in each thread, so the sidebar can mark finished work as unread. */
  seenSeq: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** When this computer started keeping `seenSeq` (ISO); older threads count as read. */
  unreadSince: z.string().default(""),
  /** Threads marked as unread by hand. */
  markedUnread: z.array(z.string()).default([]),
  /** After a turn, offer a likely next message in the empty composer (Tab takes it). */
  suggestNextPrompt: z.boolean().default(true),
  /** On Home, point out when the message names another of your projects. */
  projectHint: z.boolean().default(true),
  /** The Get started checklist on Home was put away. */
  getStartedDismissed: z.boolean().default(false),
  /** Use this computer's threads from the dashboard on your phone (docs/phone-access.md). Off until turned on. */
  phoneAccess: z.boolean().default(false),
  /** What the dashboard calls this computer; empty uses "My Mac" and the like. */
  computerName: z.string().max(100).default(""),
  /** The agents in the user's order (Settings → Agents → Harness), used by the model picker's tabs. */
  agentOrder: z.array(AgentKindPref).catch([]).default([]),
  /** Agents left out of the model picker. */
  hiddenAgents: z.array(AgentKindPref).catch([]).default([]),
  /** The model, effort and fast mode last picked for each agent, used for new threads. */
  agentChoices: z.record(z.string(), AgentChoice).catch({}).default({}),
  /** Agents installed with npm that LemonLime keeps up to date when it starts. */
  autoUpdateAgents: z.array(AgentKindPref).catch([]).default([]),
  /** The day (YYYY-MM-DD) agents were last updated by themselves, so it happens at most once a day. */
  agentsUpdatedOn: z.string().catch("").default(""),
  /** The saved ACP agent last picked (Settings → Agents → ACP agents), by id. */
  lastAcpAgent: z.string().catch("").default(""),
});
export type UiPrefs = z.infer<typeof UiPrefs>;

export function loadUiPrefs(): UiPrefs {
  const r = UiPrefs.safeParse(read(KEY_UI) ?? {});
  if (!r.success) return UiPrefs.parse({});
  // Keep every nav item exactly once, even after an update adds new ones.
  const order = [...new Set([...r.data.navOrder, ...NAV_ITEMS])].filter(i => (NAV_ITEMS as readonly string[]).includes(i));
  return { ...r.data, navOrder: order as NavItem[] };
}

export function saveUiPrefs(p: UiPrefs): void {
  write(KEY_UI, p);
}

// ── Thread side panel width ──────────────────────────────────

const KEY_PANEL_WIDTH = "lemonlime:thread-panel-width";
/** The thread panel's starting width; lib/panel.ts keeps it in bounds and snaps it. */
export const THREAD_PANEL = { default: 440 } as const;

export function loadPanelWidth(): number {
  const n = Number(read(KEY_PANEL_WIDTH));
  return Number.isFinite(n) && n > 0 ? n : THREAD_PANEL.default;
}

export function savePanelWidth(width: number): void {
  write(KEY_PANEL_WIDTH, Math.round(width));
}

// ── Subagents per thread, for the sidebar ───────────────────

const KEY_CHILDREN = "lemonlime:children";

export const SidebarChild = z.object({
  id: z.string(),
  title: z.string(),
  /** "stopped": it was still at work when its thread's runner stopped (shown, never stored as such by the runner). */
  state: z.enum(["done", "running", "waiting", "failed", "stopped"]),
});
export type SidebarChild = z.infer<typeof SidebarChild>;

/** Each thread's latest subagents, as last seen, so the sidebar shows them after a restart. */
export function loadThreadChildren(): Record<string, SidebarChild[]> {
  const r = z.record(z.string(), z.array(SidebarChild).max(50)).safeParse(read(KEY_CHILDREN));
  return r.success ? r.data : {};
}

export function saveThreadChildren(all: Record<string, SidebarChild[]>): void {
  write(KEY_CHILDREN, all);
}

// ── Unsent drafts, per thread ────────────────────────────────

const DRAFT_PREFIX = "lemonlime:draft:";

export function loadDraft(threadId: string): string {
  const v = read(DRAFT_PREFIX + threadId);
  return typeof v === "string" ? v : "";
}

/** Keep (or with empty text, forget) what was typed in a thread and not sent. */
export function saveDraft(threadId: string, text: string): void {
  const had = loadDraft(threadId) !== "";
  // Drafts longer than this aren't kept (local storage is small).
  if (text.trim() && text.length <= 100_000) write(DRAFT_PREFIX + threadId, text);
  else
    try {
      localStorage.removeItem(DRAFT_PREFIX + threadId);
    } catch {
      /* ignore */
    }
  const has = Boolean(text.trim()) && text.length <= 100_000;
  if (had !== has && typeof window !== "undefined") window.dispatchEvent(new Event("lemonlime:drafts-changed"));
}

/** Threads with an unsent draft. */
export function draftThreadIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) ids.add(k.slice(DRAFT_PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

// ── Split panes ──────────────────────────────────────────────

const KEY_SPLIT = "lemonlime:split-layout";

/** The stored split layout, unchecked (splitLayout.ts `restoreLayout` checks it). */
export function loadSplitLayout(): unknown {
  return read(KEY_SPLIT);
}

/** Keep the split layout, or forget it (null) when back to one pane. */
export function saveSplitLayout(layout: object | null): void {
  if (layout) write(KEY_SPLIT, layout);
  else
    try {
      localStorage.removeItem(KEY_SPLIT);
    } catch {
      /* ignore */
    }
}
