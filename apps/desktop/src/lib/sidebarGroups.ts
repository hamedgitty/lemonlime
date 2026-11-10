import type { AgentKind } from "@lemonlime/protocol";
import type { ThreadSummary } from "./threads.ts";
import { AGENT_LABELS, repoName } from "./format.ts";

/**
 * How the sidebar's thread list is cut into groups (by project, by where it runs, or by
 * agent), in the order the user dragged them into, each folding away and showing its
 * first few threads until asked for more.
 */

export type Organize = "project" | "place" | "agent";

export type GroupKind = "pinned" | "project" | "cloud" | "computer" | "machine" | "agent";

/** Where a project group's threads work, for "New thread in this project" and its folder. */
export type GroupProject = { mode: "local"; path: string } | { mode: "cloud"; url: string };

export interface ThreadGroup {
  /** Stable across runs: what collapse and order are saved under. */
  key: string;
  kind: GroupKind;
  label: string;
  threads: ThreadSummary[];
  /** Project groups: the folder on this computer (or else the repository) its threads use. */
  project?: GroupProject;
  agent?: AgentKind;
}

/** Threads a group shows before "Show more". */
export const GROUP_ROWS = 5;

export function groupThreads(
  threads: readonly ThreadSummary[],
  o: {
    organize: Organize;
    pinned: readonly string[];
    machineName?: (id: string) => string | undefined;
    /** Every thread, when `threads` is only some of them (a search, say), so projects are told apart the same way. */
    all?: readonly ThreadSummary[];
  },
): ThreadGroup[] {
  const pinned = threads.filter(t => o.pinned.includes(t.id));
  const homes = o.organize === "project" ? projectHomes(o.all ?? threads) : new Map<string, string>();
  const groups = new Map<string, ThreadGroup>();
  for (const t of threads) {
    if (o.pinned.includes(t.id)) continue;
    const g = describe(t, o, homes);
    const known = groups.get(g.key);
    if (known) known.threads.push(t);
    else groups.set(g.key, { ...g, threads: [t] });
    // A project's folder on this computer wins over a cloud copy of it or a remote machine's.
    const group = groups.get(g.key)!;
    if (o.organize === "project" && t.mode === "local" && !t.machine && group.project?.mode !== "local") group.project = { mode: "local", path: t.repo };
    else if (o.organize === "project" && !group.project && t.mode === "cloud") group.project = { mode: "cloud", url: t.repo };
  }
  const out = [...groups.values()];
  // Projects that only share a name show the folder (or owner) above it too.
  const named = new Map<string, number>();
  const name = (g: ThreadGroup) => g.label.toLowerCase();
  for (const g of out) if (g.kind === "project") named.set(name(g), (named.get(name(g)) ?? 0) + 1);
  for (const g of out) if (g.kind === "project" && named.get(name(g))! > 1) g.label = longName(g.threads[0]!.repo);
  if (pinned.length) out.unshift({ key: "pinned", kind: "pinned", label: "Pinned", threads: pinned });
  return out;
}

function describe(
  t: ThreadSummary,
  o: { organize: Organize; machineName?: (id: string) => string | undefined },
  homes: ReadonlyMap<string, string>,
): Omit<ThreadGroup, "threads"> {
  if (o.organize === "agent") return { key: `agent:${t.agent.kind}`, kind: "agent", label: AGENT_LABELS[t.agent.kind], agent: t.agent.kind };
  if (o.organize === "place") {
    if (t.mode === "cloud") return { key: "place:cloud", kind: "cloud", label: "Cloud" };
    if (t.machine) return { key: `place:machine:${t.machine}`, kind: "machine", label: `On ${o.machineName?.(t.machine) ?? "a removed machine"}` };
    return { key: "place:local", kind: "computer", label: "On this computer" };
  }
  const place = projectPlace(t);
  return { key: `project:${homes.get(place) ?? place}`, kind: "project", label: repoName(t.repo) };
}

/**
 * Where a thread's code is, written one way: the folder on this computer, the folder on
 * another machine, or the repository. Two projects are the same only if this is.
 */
export function projectPlace(t: Pick<ThreadSummary, "mode" | "repo" | "machine">): string {
  if (t.mode === "cloud") {
    const url = t.repo
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/^[^@/]*@/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .replace(":", "/");
    return `cloud:${url}`;
  }
  const path = t.repo.trim().replace(/[\\/]+$/, "");
  return t.machine ? `machine:${t.machine}:${path}` : `local:${path}`;
}

/**
 * A cloud copy of a project, or another machine's, sits with its folder on this computer
 * when the name leaves no doubt: one folder here, one repository, one folder elsewhere.
 * Same-named projects in two folders (or two repositories) each keep a group of their own.
 * Maps a place to the place whose group it joins.
 */
function projectHomes(threads: readonly ThreadSummary[]): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const t of threads) {
    const name = repoName(t.repo).toLowerCase();
    byName.set(name, (byName.get(name) ?? new Set()).add(projectPlace(t)));
  }
  const homes = new Map<string, string>();
  for (const places of byName.values()) {
    const of = (kind: string) => [...places].filter(p => p.startsWith(`${kind}:`));
    const [here, cloud, machine] = [of("local"), of("cloud"), of("machine")];
    if (here.length > 1 || cloud.length > 1 || machine.length > 1) continue;
    const home = here[0] ?? cloud[0] ?? machine[0]!;
    for (const p of places) homes.set(p, home);
  }
  return homes;
}

/** A project's name with the folder (or owner) above it. */
function longName(pathOrUrl: string): string {
  const parts = pathOrUrl
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/, "")
    .split(/[\\/:]/)
    .filter(Boolean);
  return parts.slice(-2).join("/") || pathOrUrl;
}

/**
 * Saved group keys from when a project went by its short name alone, moved over to the keys
 * its groups have now. Null when there is nothing to move.
 */
export function carryGroupKeys(saved: readonly string[], groups: readonly ThreadGroup[]): string[] | null {
  const now = new Map<string, string[]>();
  for (const g of groups) {
    if (g.kind !== "project" || !g.threads[0]) continue;
    const old = `project:${repoName(g.threads[0].repo)}`;
    now.set(old, [...(now.get(old) ?? []), g.key]);
  }
  if (!saved.some(k => now.has(k))) return null;
  return [...new Set(saved.flatMap(k => now.get(k) ?? [k]))];
}

/**
 * Groups in the saved order; ones not in it yet keep their place after the ordered ones
 * (newest activity first). Pinned stays on top.
 */
export function orderGroups(groups: readonly ThreadGroup[], order: readonly string[]): ThreadGroup[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  const pinned = groups.filter(g => g.kind === "pinned");
  const rest = groups.filter(g => g.kind !== "pinned");
  const ordered = rest.filter(g => rank.has(g.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...pinned, ...ordered, ...rest.filter(g => !rank.has(g.key))];
}

/**
 * The saved order after moving `key` to `to` among the groups showing (`shown`, in their
 * current order). Keys of groups not showing now (another organize mode, all archived)
 * stay saved, after these.
 */
export function moveGroup(order: readonly string[], shown: readonly string[], key: string, to: number): string[] {
  const list = shown.filter(k => k !== key && k !== "pinned");
  if (!shown.includes(key) || key === "pinned") return [...order];
  list.splice(Math.max(0, Math.min(to, list.length)), 0, key);
  return [...list, ...order.filter(k => !list.includes(k))];
}

export function toggleKey(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(k => k !== key) : [...list, key];
}

/**
 * The rows a group shows: the first few, or all once expanded. The open thread always
 * shows, so it never hides behind "Show more".
 */
export function groupRows<T extends { id: string }>(
  threads: readonly T[],
  o: { expanded: boolean; selectedId: string | null; limit?: number },
): { shown: T[]; hidden: number } {
  const limit = o.limit ?? GROUP_ROWS;
  // One more than the limit isn't worth a "Show 1 more" row.
  if (o.expanded || threads.length <= limit + 1) return { shown: [...threads], hidden: 0 };
  const shown = threads.slice(0, limit);
  const selected = o.selectedId ? threads.slice(limit).find(t => t.id === o.selectedId) : undefined;
  if (selected) shown.push(selected);
  return { shown, hidden: threads.length - shown.length };
}

// ── Snoozed threads ─────────────────────────────────────────

/** Snoozed until a later time (ISO, by thread id), so out of the list for now. */
export function isSnoozed(id: string, snoozed: Readonly<Record<string, string>>, now: number): boolean {
  const until = snoozed[id];
  return until !== undefined && Date.parse(until) > now;
}

/** The threads the list shows now, and the snoozed ones (soonest back first). */
export function splitSnoozed<T extends { id: string }>(
  threads: readonly T[],
  snoozed: Readonly<Record<string, string>>,
  now: number,
): { awake: T[]; snoozed: T[] } {
  const awake: T[] = [];
  const asleep: T[] = [];
  for (const t of threads) (isSnoozed(t.id, snoozed, now) ? asleep : awake).push(t);
  asleep.sort((a, b) => Date.parse(snoozed[a.id]!) - Date.parse(snoozed[b.id]!));
  return { awake, snoozed: asleep };
}

/**
 * Snoozes that end now: their time has come, or the thread needs you (the agent asks for an
 * approval or an answer, or its turn failed). `woke` are the threads coming back, to mark
 * unread; snoozes that have expired are dropped from `snoozed` without counting as woken
 * twice.
 */
export function wakeSnoozes(
  snoozed: Readonly<Record<string, string>>,
  now: number,
  needsYou: ReadonlySet<string> = new Set(),
): { snoozed: Record<string, string>; woke: string[] } {
  const next: Record<string, string> = {};
  const woke: string[] = [];
  for (const [id, until] of Object.entries(snoozed)) {
    const t = Date.parse(until);
    if (Number.isNaN(t) || t <= now || needsYou.has(id)) woke.push(id);
    else next[id] = until;
  }
  return { snoozed: woke.length ? next : { ...snoozed }, woke };
}

/** When the next snooze ends (ms since the epoch), or null with none left. */
export function nextWake(snoozed: Readonly<Record<string, string>>, now: number): number | null {
  let soonest: number | null = null;
  for (const until of Object.values(snoozed)) {
    const t = Date.parse(until);
    if (t > now && (soonest === null || t < soonest)) soonest = t;
  }
  return soonest;
}

/** Threads that need you now but didn't before: these cut a snooze short. */
export function newlyNeedingYou(before: ReadonlySet<string>, now: ReadonlySet<string>): string[] {
  return [...now].filter(id => !before.has(id));
}
