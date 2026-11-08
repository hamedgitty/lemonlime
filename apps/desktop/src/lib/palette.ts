import { fuzzyMatch, type FuzzyMatch } from "@lemonlime/protocol";
import { COMPOSER_SHORTCUTS, SHORTCUTS, type ShortcutId } from "./shortcuts.ts";

/**
 * The command palette (⌘K): threads, projects and app commands in one fuzzy search.
 * Typing `>` first searches commands only. Recent picks come first and are kept in
 * local storage. App commands come from the shortcut list, so every shortcut is also a
 * command and shows its keys.
 */

export type PaletteSection = "recent" | "threads" | "projects" | "commands";

export interface PaletteItem {
  /** Unique across kinds, e.g. "thread:abc", "project:/path", "command:new-thread". */
  id: string;
  section: Exclude<PaletteSection, "recent">;
  label: string;
  /** Second line or trailing detail (repository, folder). Searched too, but counts less. */
  detail?: string;
  /** Extra words that find it ("dark mode" for the theme). Not shown. */
  keywords?: string;
  /** Its shortcut, so the palette can show the keys. */
  shortcut?: ShortcutId;
}

export interface RankedItem {
  item: PaletteItem;
  /** Matched letters in the label. */
  match: FuzzyMatch;
}

export interface PaletteGroup {
  section: PaletteSection;
  items: RankedItem[];
}

const LIMITS: Record<PaletteSection, number> = { recent: 5, threads: 20, projects: 8, commands: 40 };
/** Without a query: how many of each kind to show. */
const IDLE_LIMITS: Record<PaletteSection, number> = { recent: 5, threads: 8, projects: 5, commands: 40 };

/** Settings pages and other commands that aren't keyboard shortcuts. */
export interface ExtraCommand {
  id: string;
  label: string;
  keywords?: string;
}

/** Every app command: each shortcut (but the palette's own), then the extras. */
export function appCommands(extras: readonly ExtraCommand[], skip: readonly ShortcutId[] = []): PaletteItem[] {
  const fromShortcuts = SHORTCUTS.filter(s => s.id !== "search" && !COMPOSER_SHORTCUTS.includes(s.id) && !skip.includes(s.id)).map<PaletteItem>(s => ({
    id: `command:${s.id}`,
    section: "commands",
    label: s.label,
    shortcut: s.id,
  }));
  return [
    ...fromShortcuts,
    ...extras.map<PaletteItem>(e => ({ id: `command:${e.id}`, section: "commands", label: e.label, ...(e.keywords ? { keywords: e.keywords } : {}) })),
  ];
}

/** What `>` does: commands only, the rest of the text is the query. */
export function parseQuery(raw: string): { commandsOnly: boolean; query: string } {
  const t = raw.trimStart();
  if (t.startsWith(">")) return { commandsOnly: true, query: t.slice(1).trim() };
  return { commandsOnly: false, query: raw.trim() };
}

function score(item: PaletteItem, query: string): FuzzyMatch | null {
  const label = fuzzyMatch(query, item.label);
  if (label) return label;
  // Every word found in the detail or keywords still finds it, below label matches.
  const extra = `${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length && words.every(w => extra.includes(w)) ? { score: -5, positions: [] } : null;
}

/**
 * The groups to show for `raw` (what was typed), recent picks (ids, newest first) leading.
 * With no query, the most recent picks get their own group; with one, they rank higher
 * within their kind.
 */
export function rankPalette(items: readonly PaletteItem[], raw: string, recents: readonly string[]): PaletteGroup[] {
  const { commandsOnly, query } = parseQuery(raw);
  const pool = commandsOnly ? items.filter(i => i.section === "commands") : items;
  const recentRank = new Map(recents.map((id, i) => [id, i]));
  const boost = (id: string) => {
    const r = recentRank.get(id);
    return r === undefined ? 0 : 1.5 - r * 0.1;
  };

  if (!query) {
    const groups: PaletteGroup[] = [];
    const shownRecent = new Set<string>();
    if (!commandsOnly) {
      const byId = new Map(pool.map(i => [i.id, i]));
      const recent = recents
        .map(id => byId.get(id))
        .filter((i): i is PaletteItem => Boolean(i))
        .slice(0, IDLE_LIMITS.recent);
      recent.forEach(i => shownRecent.add(i.id));
      if (recent.length) groups.push({ section: "recent", items: recent.map(item => ({ item, match: { score: 0, positions: [] } })) });
    }
    for (const section of ["threads", "projects", "commands"] as const) {
      const list = pool
        .filter(i => i.section === section && !shownRecent.has(i.id))
        .slice(0, IDLE_LIMITS[section])
        .map(item => ({ item, match: { score: 0, positions: [] } }));
      if (list.length) groups.push({ section, items: list });
    }
    return groups;
  }

  const groups: PaletteGroup[] = [];
  for (const section of ["threads", "projects", "commands"] as const) {
    const ranked: (RankedItem & { i: number })[] = [];
    pool.forEach((item, i) => {
      if (item.section !== section) return;
      const m = score(item, query);
      if (m) ranked.push({ item, match: { ...m, score: m.score + boost(item.id) }, i });
    });
    ranked.sort((a, b) => b.match.score - a.match.score || a.i - b.i);
    if (ranked.length) groups.push({ section, items: ranked.slice(0, LIMITS[section]).map(({ item, match }) => ({ item, match })) });
  }
  // The kind with the best match goes first.
  return groups.sort((a, b) => b.items[0]!.match.score - a.items[0]!.match.score);
}

// ── Recent picks ─────────────────────────────────────────

const KEY_RECENTS = "lemonlime:palette-recents";
const MAX_RECENTS = 12;

export function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_RECENTS) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

/** Puts `id` first; returns the new list (and stores it if it can). */
export function rememberPick(recents: readonly string[], id: string): string[] {
  const next = [id, ...recents.filter(r => r !== id)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(KEY_RECENTS, JSON.stringify(next));
  } catch {
    /* storage blocked: recents last until the app closes */
  }
  return next;
}
