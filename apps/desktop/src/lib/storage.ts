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
});
export type Settings = z.infer<typeof Settings>;

export const LocalThreadMeta = z.object({
  id: ThreadId,
  title: z.string().default(""),
  agent: AgentConfig,
  repoPath: z.string(),
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

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
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

export const NAV_ITEMS = ["new", "search"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

export const UiPrefs = z.object({
  /** Sidebar nav items in order; those in `hiddenNav` are not shown. */
  navOrder: z.array(z.enum(NAV_ITEMS)).default([...NAV_ITEMS]),
  hiddenNav: z.array(z.enum(NAV_ITEMS)).default(["search"]),
  organize: z.enum(["project", "place", "agent"]).default("project"),
  sort: z.enum(["recent", "name"]).default("recent"),
  pinned: z.array(z.string()).default([]),
  sidebarCollapsed: z.boolean().default(false),
  /** Projects (repository folders) used for local threads, most recent first. */
  recentProjects: z.array(z.string()).default([]),
  /** Last agent and place chosen in the composer. */
  lastAgent: z.enum(["claude-code", "codex", "opencode", "acp"]).default("claude-code"),
  lastPlace: z.enum(["local", "cloud"]).default("local"),
  rightPanel: z.boolean().default(false),
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
