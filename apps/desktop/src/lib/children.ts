import type { ChildState, ChildWork } from "@lemonlime/protocol";
import type { SidebarChild } from "./storage.ts";

/**
 * Subagents in the sidebar: each thread's latest ones, nested under it, with a small grid of
 * cells (one per subagent) that says how far along they are.
 */

/** Most subagents kept per thread. */
export const CHILDREN_KEPT = 50;
/** Cells in a row's progress grid before "+N". */
export const GRID_CELLS = 12;

export const CHILD_STATE_LABEL: Record<ChildState, string> = { done: "Done", running: "Running", waiting: "Waiting", failed: "Failed" };

/** Store a thread's subagents (dropping the thread once it has none). Same object back when nothing changed. */
export function withChildren(all: Record<string, SidebarChild[]>, threadId: string, list: readonly ChildWork[]): Record<string, SidebarChild[]> {
  const next = list.slice(-CHILDREN_KEPT).map(c => ({ id: c.id, title: c.title.slice(0, 200), state: c.state }));
  const before = all[threadId];
  if (!next.length) {
    if (!before) return all;
    const { [threadId]: _gone, ...rest } = all;
    return rest;
  }
  if (before && before.length === next.length && before.every((c, i) => c.id === next[i]!.id && c.state === next[i]!.state && c.title === next[i]!.title))
    return all;
  return { ...all, [threadId]: next };
}

/** A thread whose runner isn't running can't have subagents at work: they stopped with it. */
export function settled(list: readonly SidebarChild[], runnerUp: boolean): SidebarChild[] {
  if (runnerUp) return [...list];
  return list.map(c => (c.state === "running" || c.state === "waiting" ? { ...c, state: "failed" as const } : c));
}

/** The grid's cells in a steady order (done, running, waiting, failed), and how many didn't fit. */
export function gridCells(list: readonly SidebarChild[], max = GRID_CELLS): { cells: SidebarChild[]; more: number } {
  const order: Record<ChildState, number> = { done: 0, running: 1, waiting: 2, failed: 3 };
  const sorted = [...list].sort((a, b) => order[a.state] - order[b.state]);
  return { cells: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

/** "3 subagents: 1 done, 2 running", for screen readers and the row's tooltip. */
export function childrenSummary(list: readonly SidebarChild[]): string {
  const counts = new Map<ChildState, number>();
  for (const c of list) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  const parts = (["done", "running", "waiting", "failed"] as const)
    .filter(s => counts.get(s))
    .map(s => `${counts.get(s)} ${CHILD_STATE_LABEL[s].toLowerCase()}`);
  return `${list.length} ${list.length === 1 ? "subagent" : "subagents"}: ${parts.join(", ")}`;
}
