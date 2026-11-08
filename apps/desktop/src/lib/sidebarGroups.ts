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
  o: { organize: Organize; pinned: readonly string[]; machineName?: (id: string) => string | undefined },
): ThreadGroup[] {
  const pinned = threads.filter(t => o.pinned.includes(t.id));
  const groups = new Map<string, ThreadGroup>();
  for (const t of threads) {
    if (o.pinned.includes(t.id)) continue;
    const g = describe(t, o);
    const known = groups.get(g.key);
    if (known) known.threads.push(t);
    else groups.set(g.key, { ...g, threads: [t] });
    // A project's folder on this computer wins over a cloud copy of it or a remote machine's.
    const group = groups.get(g.key)!;
    if (o.organize === "project" && t.mode === "local" && !t.machine && group.project?.mode !== "local") group.project = { mode: "local", path: t.repo };
    else if (o.organize === "project" && !group.project && t.mode === "cloud") group.project = { mode: "cloud", url: t.repo };
  }
  const out = [...groups.values()];
  if (pinned.length) out.unshift({ key: "pinned", kind: "pinned", label: "Pinned", threads: pinned });
  return out;
}

function describe(t: ThreadSummary, o: { organize: Organize; machineName?: (id: string) => string | undefined }): Omit<ThreadGroup, "threads"> {
  if (o.organize === "agent") return { key: `agent:${t.agent.kind}`, kind: "agent", label: AGENT_LABELS[t.agent.kind], agent: t.agent.kind };
  if (o.organize === "place") {
    if (t.mode === "cloud") return { key: "place:cloud", kind: "cloud", label: "Cloud" };
    if (t.machine) return { key: `place:machine:${t.machine}`, kind: "machine", label: `On ${o.machineName?.(t.machine) ?? "a removed machine"}` };
    return { key: "place:local", kind: "computer", label: "On this computer" };
  }
  const name = repoName(t.repo);
  return { key: `project:${name}`, kind: "project", label: name };
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
