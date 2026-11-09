import { fuzzyMatch, type FuzzyMatch } from "@lemonlime/protocol";
import { COMPOSER_SHORTCUTS, SHORTCUTS, type ShortcutId } from "./shortcuts.ts";

/**
 * The command palette (⌘K): threads, projects and app commands in one fuzzy search, and
 * what was said in threads, last. Typing `>` first searches commands only. Recent picks
 * come first and are kept in local storage. App commands come from the shortcut list, so
 * every shortcut is also a command and shows its keys; single settings and "New thread in
 * <project>" show once you type.
 */

export type PaletteSection = "recent" | "threads" | "projects" | "commands" | "messages";

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
  /** Shown at the row's end, e.g. how long ago a thread last moved. */
  trailing?: string;
  /** Listed after the rest of its kind (the thread already open). */
  demote?: boolean;
  /** Only once something is typed: too many to list on an empty search. */
  searchOnly?: boolean;
  /** Where its label matched, when that's known up front (a message's snippet). */
  positions?: number[];
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

const LIMITS: Record<PaletteSection, number> = { recent: 5, threads: 20, projects: 8, commands: 40, messages: 8 };
/** Without a query: how many of each kind to show. */
const IDLE_LIMITS: Record<PaletteSection, number> = { recent: 5, threads: 8, projects: 5, commands: 40, messages: 0 };
/** The kinds ranked by how well they match; messages always come last, in their own order. */
const RANKED = ["threads", "projects", "commands"] as const;

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
  // The open thread goes after the others of its kind.
  const lastIfDemoted = <T extends { item: PaletteItem }>(list: T[]) => [...list.filter(r => !r.item.demote), ...list.filter(r => r.item.demote)];
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
        .filter((i): i is PaletteItem => Boolean(i) && !i!.searchOnly && i!.section !== "messages")
        .slice(0, IDLE_LIMITS.recent);
      recent.forEach(i => shownRecent.add(i.id));
      if (recent.length) groups.push({ section: "recent", items: recent.map(item => ({ item, match: { score: 0, positions: [] } })) });
    }
    for (const section of RANKED) {
      const list = lastIfDemoted(
        pool.filter(i => i.section === section && !shownRecent.has(i.id) && !i.searchOnly).map(item => ({ item, match: { score: 0, positions: [] } })),
      ).slice(0, IDLE_LIMITS[section]);
      if (list.length) groups.push({ section, items: list });
    }
    return groups;
  }

  const groups: PaletteGroup[] = [];
  for (const section of RANKED) {
    const ranked: (RankedItem & { i: number })[] = [];
    pool.forEach((item, i) => {
      if (item.section !== section) return;
      const m = score(item, query);
      if (m) ranked.push({ item, match: { ...m, score: m.score + boost(item.id) }, i });
    });
    ranked.sort((a, b) => Number(Boolean(a.item.demote)) - Number(Boolean(b.item.demote)) || b.match.score - a.match.score || a.i - b.i);
    if (ranked.length) groups.push({ section, items: ranked.slice(0, LIMITS[section]).map(({ item, match }) => ({ item, match })) });
  }
  // The kind with the best match goes first; what was said in threads, after everything else.
  groups.sort((a, b) => b.items[0]!.match.score - a.items[0]!.match.score);
  const messages = commandsOnly ? [] : pool.filter(i => i.section === "messages").slice(0, LIMITS.messages);
  if (messages.length) groups.push({ section: "messages", items: messages.map(item => ({ item, match: { score: 0, positions: item.positions ?? [] } })) });
  return groups;
}

// ── What was said in threads ────────────────────────────────

/** One message from a thread's cached history, for searching. */
export interface MessageText {
  threadId: string;
  threadTitle: string;
  seq: number;
  from: "you" | "agent";
  text: string;
}

/** How much of a message shows around the match, in characters. */
const SNIPPET = 90;
/** Messages shown from any one thread, so one long thread doesn't fill the list. */
const PER_THREAD = 2;

/**
 * Messages containing every word of the query (any case), newest first, as palette rows:
 * a snippet around the first match with it marked, and the thread's title.
 */
export function searchMessages(messages: readonly MessageText[], query: string, limit = LIMITS.messages): PaletteItem[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 0);
  if (!words.length || words.join("").length < 2) return [];
  const out: PaletteItem[] = [];
  const perThread = new Map<string, number>();
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i]!;
    if ((perThread.get(m.threadId) ?? 0) >= PER_THREAD) continue;
    const flat = m.text.replace(/\s+/g, " ").trim();
    const lower = flat.toLowerCase();
    if (!words.every(w => lower.includes(w))) continue;
    const { text, positions } = snippet(flat, lower.indexOf(words[0]!), words[0]!.length);
    perThread.set(m.threadId, (perThread.get(m.threadId) ?? 0) + 1);
    out.push({
      id: `message:${m.threadId}:${m.seq}`,
      section: "messages",
      label: text,
      detail: `${m.from === "you" ? "You" : "Agent"}, in ${m.threadTitle || "Untitled thread"}`,
      positions,
    });
  }
  return out;
}

/** About SNIPPET characters of `text` around a match at `at`, with the match's letters. */
function snippet(text: string, at: number, length: number): { text: string; positions: number[] } {
  const start = Math.max(0, Math.min(at - 30, text.length - SNIPPET));
  const cut = start > 0 ? text.indexOf(" ", start) + 1 || start : 0;
  const from = cut > at ? start : cut;
  const end = Math.min(text.length, from + SNIPPET);
  const lead = from > 0 ? "…" : "";
  const body = text.slice(from, end) + (end < text.length ? "…" : "");
  const first = at - from + lead.length;
  return { text: lead + body, positions: Array.from({ length }, (_, k) => first + k) };
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
