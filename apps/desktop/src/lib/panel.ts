import { z } from "zod";
import { DEFAULT_TERMINAL_ID, MAX_TERMINALS } from "@lemonlime/protocol";

/**
 * The thread panel's tabs: the built-in views (changes, browser, side chat), then the
 * terminals and files the user opened, in their own order. Kept per thread on this
 * computer, with the last few closed tabs so ⌘⇧T can bring one back.
 */

export const BUILT_IN_TABS = ["changes", "browser", "side"] as const;
export type BuiltInTab = (typeof BUILT_IN_TABS)[number];

export const PanelTab = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), id: z.string().min(1).max(60), terminal: z.string().min(1).max(40), n: z.number().int().positive() }),
  z.object({
    kind: z.literal("file"),
    id: z.string().min(1).max(4200),
    path: z.string().min(1).max(4096),
    /** The line to show (from a `path:line` link). */
    line: z.number().int().positive().optional(),
  }),
]);
export type PanelTab = z.infer<typeof PanelTab>;

export const PanelState = z.object({
  /** The terminals and files, in order (built-in tabs always come first). */
  tabs: z.array(PanelTab).max(64).default([]),
  /** A built-in tab name or a tab id. */
  active: z.string().default("changes"),
  /** Recently closed, newest last. */
  closed: z.array(PanelTab).max(20).default([]),
});
export type PanelState = z.infer<typeof PanelState>;

/** How many closed tabs ⌘⇧T can bring back. */
export const CLOSED_KEPT = 10;

export const emptyPanel = (): PanelState => ({ tabs: [], active: "changes", closed: [] });

const key = (threadId: string) => `lemonlime:panel:${threadId}`;

export function loadPanelState(threadId: string): PanelState {
  try {
    const raw = localStorage.getItem(key(threadId));
    const r = PanelState.safeParse(raw ? JSON.parse(raw) : {});
    return r.success ? r.data : emptyPanel();
  } catch {
    return emptyPanel();
  }
}

export function savePanelState(threadId: string, state: PanelState): void {
  try {
    // A thread whose panel was never changed keeps nothing.
    if (!state.tabs.length && !state.closed.length && state.active === "changes") localStorage.removeItem(key(threadId));
    else localStorage.setItem(key(threadId), JSON.stringify(state));
  } catch {
    /* storage full: the tabs just aren't remembered */
  }
}

export const fileTabId = (path: string) => `file:${path}`;

/** Open a tab (or switch to it if it's open already). New tabs go to the end. */
export function openTab(s: PanelState, tab: PanelTab): PanelState {
  if (s.tabs.some(t => t.id === tab.id)) return { ...s, active: tab.id };
  return { ...s, tabs: [...s.tabs, tab], active: tab.id };
}

/** Open a file's tab, at `line` when given (an open tab moves to that line). */
export function openFile(s: PanelState, path: string, line?: number): PanelState {
  const id = fileTabId(path);
  const tab: PanelTab = { kind: "file", id, path, ...(line ? { line } : {}) };
  if (line && s.tabs.some(t => t.id === id)) return { ...s, tabs: s.tabs.map(t => (t.id === id ? tab : t)), active: id };
  return openTab(s, tab);
}

export const terminalCount = (s: PanelState) => s.tabs.filter(t => t.kind === "terminal").length;

/**
 * A new terminal tab, or null when the thread has as many as the runner allows. The first
 * one uses the runner's default terminal, so a shell from before carries on; each is
 * numbered with the lowest number free.
 */
export function newTerminal(s: PanelState, random: () => string = () => Math.random().toString(36).slice(2, 10)): PanelState | null {
  const terms = s.tabs.filter((t): t is Extract<PanelTab, { kind: "terminal" }> => t.kind === "terminal");
  if (terms.length >= MAX_TERMINALS) return null;
  const used = new Set(terms.map(t => t.n));
  let n = 1;
  while (used.has(n)) n++;
  const terminal = terms.some(t => t.terminal === DEFAULT_TERMINAL_ID) ? `t-${random()}` : DEFAULT_TERMINAL_ID;
  return openTab(s, { kind: "terminal", id: `term:${terminal}`, terminal, n });
}

/** Close a tab; the one to its right (or left) becomes active if it was. */
export function closeTab(s: PanelState, id: string): PanelState {
  const at = s.tabs.findIndex(t => t.id === id);
  if (at < 0) return s;
  const tab = s.tabs[at]!;
  const tabs = s.tabs.filter(t => t.id !== id);
  const active = s.active === id ? (tabs[at]?.id ?? tabs[at - 1]?.id ?? "changes") : s.active;
  const closed = [...s.closed.filter(t => t.id !== id), tab].slice(-CLOSED_KEPT);
  return { tabs, active, closed };
}

/** Bring back the last closed tab. A terminal comes back with a fresh shell under its old name. */
export function reopenTab(s: PanelState): PanelState {
  const closed = [...s.closed];
  while (closed.length) {
    const tab = closed.pop()!;
    if (s.tabs.some(t => t.id === tab.id)) continue;
    if (tab.kind === "terminal") {
      const used = new Set(s.tabs.flatMap(t => (t.kind === "terminal" ? [t.n] : [])));
      if (used.size >= MAX_TERMINALS) return s;
      let n = tab.n;
      if (used.has(n)) for (n = 1; used.has(n); n++);
      return openTab({ ...s, closed }, { ...tab, n });
    }
    return openTab({ ...s, closed }, tab);
  }
  return { ...s, closed };
}

/** Move a tab to another place among the opened tabs. */
export function moveTab(s: PanelState, id: string, to: number): PanelState {
  const from = s.tabs.findIndex(t => t.id === id);
  if (from < 0) return s;
  const tabs = [...s.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab!);
  return { ...s, tabs };
}

export const isBuiltIn = (id: string): id is BuiltInTab => (BUILT_IN_TABS as readonly string[]).includes(id);

/** The active tab, falling back to Changes when it no longer exists. */
export function activeTab(s: PanelState): string {
  return isBuiltIn(s.active) || s.tabs.some(t => t.id === s.active) ? s.active : "changes";
}

/** "zsh", "zsh 2"…; the title the shell set (often its folder) wins when there is one. */
export function terminalLabel(tab: { n: number }, shell: string | undefined, title: string | undefined): string {
  const t = title?.trim();
  if (t) return shortTitle(t);
  return `${shell || "Terminal"}${tab.n > 1 ? ` ${tab.n}` : ""}`;
}

/** Shells often set "user@host: ~/code/app"; the last folder is what tells tabs apart. */
export function shortTitle(title: string): string {
  const afterColon = title.includes(": ") ? title.slice(title.lastIndexOf(": ") + 2) : title;
  const parts = afterColon.split("/").filter(Boolean);
  const last = parts.at(-1) ?? afterColon;
  return (last === "~" || !last ? afterColon : last).slice(0, 40);
}

export const fileName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

// ── Width: drag with gentle snap points ─────────────────────

export const PANEL_WIDTH = {
  min: 320,
  max: 1400,
  default: 440,
  /**
   * The conversation keeps at least this much room beside the panel. The smallest window
   * (900) less the sidebar (288) leaves 612: just room for this and the narrowest panel.
   */
  conversationMin: 290,
  /** Below this, a narrower panel is allowed rather than squeezing the conversation. */
  floor: 240,
  /** How close a drag must come to a snap point to stick to it. */
  snap: 14,
} as const;

/** Bounds for the panel, given the room the thread has (conversation + panel). */
export function panelBounds(available: number): { min: number; max: number } {
  const max = Math.max(PANEL_WIDTH.floor, Math.min(PANEL_WIDTH.max, available - PANEL_WIDTH.conversationMin));
  return { min: Math.min(PANEL_WIDTH.min, max), max };
}

export function clampPanel(width: number, available: number): number {
  const { min, max } = panelBounds(available);
  return Math.round(Math.max(min, Math.min(max, width)));
}

/** The widths a drag sticks to: a few fixed ones and half the window, where they fit. */
export function snapPoints(available: number, windowWidth: number): number[] {
  const { min, max } = panelBounds(available);
  const points = [320, 440, 640, Math.round(windowWidth / 2)].filter(p => p >= min && p <= max);
  return [...new Set(points)].sort((a, b) => a - b);
}

/** A dragged width: kept in bounds, and pulled to a snap point when it comes close. */
export function snapPanel(width: number, available: number, windowWidth: number): number {
  const w = clampPanel(width, available);
  let best: number | null = null;
  for (const p of snapPoints(available, windowWidth))
    if (Math.abs(p - w) <= PANEL_WIDTH.snap && (best === null || Math.abs(p - w) < Math.abs(best - w))) best = p;
  return best ?? w;
}

/** Arrow keys on the handle step to the next snap point that way (or the bound). */
export function stepPanel(width: number, dir: 1 | -1, available: number, windowWidth: number): number {
  const { min, max } = panelBounds(available);
  const points = [min, ...snapPoints(available, windowWidth), max];
  const next = dir > 0 ? points.find(p => p > width + 1) : [...points].reverse().find(p => p < width - 1);
  return next ?? width;
}
