import { z } from "zod";

/**
 * Split panes: several threads side by side. The layout is a tree whose leaves are
 * panes and whose inner nodes split their space in a row (side by side) or a column
 * (stacked), each child taking a share (`sizes`, adding up to 1). Every operation here
 * is pure and returns a new layout, so the app can keep it in state and store it.
 */

export const MAX_PANES = 6;
/** The narrowest a pane may get while dragging a divider, in pixels. */
export const MIN_PANE_PX = 280;

export type PaneContent = { kind: "thread"; mode: "local" | "cloud"; id: string } | { kind: "new" };
export interface PaneNode {
  type: "pane";
  id: string;
  content: PaneContent;
}
export interface SplitNode {
  type: "split";
  id: string;
  /** "row" puts children side by side; "column" stacks them. */
  dir: "row" | "column";
  children: LayoutNode[];
  /** Each child's share of the space, adding up to 1. */
  sizes: number[];
}
export type LayoutNode = PaneNode | SplitNode;
export interface SplitLayout {
  root: LayoutNode;
  /** The pane that gets the keyboard. */
  active: string;
  /** A pane shown alone for now, the rest kept as they are. */
  maximised: string | null;
}

export type Side = "left" | "right" | "top" | "bottom";
export type DropZone = Side | "center";

// ── Reading ──────────────────────────────────────────────

/** Every pane, in reading order (left to right, top to bottom). */
export function panes(node: LayoutNode | SplitLayout): PaneNode[] {
  const n = "root" in node ? node.root : node;
  return n.type === "pane" ? [n] : n.children.flatMap(c => panes(c));
}

export function findPane(layout: SplitLayout, paneId: string): PaneNode | undefined {
  return panes(layout).find(p => p.id === paneId);
}

/** The pane showing a thread, if any. */
export function paneForThread(layout: SplitLayout, threadId: string): PaneNode | undefined {
  return panes(layout).find(p => p.content.kind === "thread" && p.content.id === threadId);
}

/** Thread ids open in the layout. */
export function openThreadIds(layout: SplitLayout | null): Set<string> {
  const ids = new Set<string>();
  if (layout) for (const p of panes(layout)) if (p.content.kind === "thread") ids.add(p.content.id);
  return ids;
}

/** A layout of one pane. */
export function singlePane(content: PaneContent, paneId: string): SplitLayout {
  return { root: { type: "pane", id: paneId, content }, active: paneId, maximised: null };
}

export function canSplit(layout: SplitLayout): boolean {
  return panes(layout).length < MAX_PANES;
}

// ── Changing ─────────────────────────────────────────────

/** The same thread (new-thread panes are never the same as each other). */
const sameContent = (a: PaneContent, b: PaneContent) => a.kind === "thread" && b.kind === "thread" && a.id === b.id;

/** Rebuilds the tree with `fn` applied to each pane (null removes it), tidying splits on the way up. */
function mapPanes(node: LayoutNode, fn: (p: PaneNode) => LayoutNode | null): LayoutNode | null {
  if (node.type === "pane") return fn(node);
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const next = mapPanes(c, fn);
    if (!next) return;
    // A child split the same way as this one merges into it.
    if (next.type === "split" && next.dir === node.dir) {
      next.children.forEach((g, j) => {
        children.push(g);
        sizes.push(next.sizes[j]! * node.sizes[i]!);
      });
    } else {
      children.push(next);
      sizes.push(node.sizes[i]!);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  // Whatever was removed is shared out among the rest, in proportion.
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: sizes.map(s => s / total) };
}

/** Takes a pane out; its siblings take its space. Null when it was the last one. */
export function closePane(layout: SplitLayout, paneId: string): SplitLayout | null {
  const order = panes(layout);
  const at = order.findIndex(p => p.id === paneId);
  if (at < 0) return layout;
  const root = mapPanes(layout.root, p => (p.id === paneId ? null : p));
  if (!root) return null;
  // The pane next to it in reading order gets the keyboard if the closed one had it.
  const left = panes(root);
  const active = layout.active === paneId ? (order[at + 1] ?? order[at - 1])!.id : layout.active;
  return {
    root,
    active: left.some(p => p.id === active) ? active : left[0]!.id,
    maximised: layout.maximised === paneId ? null : layout.maximised,
  };
}

/**
 * Splits a pane, putting `content` on `side` of it in a new pane (which becomes active).
 * A thread already open elsewhere moves. Nothing changes at the pane limit, or when the
 * thread is already the pane being split.
 */
export function splitPane(layout: SplitLayout, paneId: string, side: Side, content: PaneContent, newId: string): SplitLayout {
  const target = findPane(layout, paneId);
  if (!target || sameContent(target.content, content)) return layout;
  // Moving a thread that's open in another pane: close that one first.
  const elsewhere = content.kind === "thread" ? paneForThread(layout, content.id) : undefined;
  let base: SplitLayout | null = layout;
  if (elsewhere) base = closePane(layout, elsewhere.id);
  if (!base || !findPane(base, paneId) || !canSplit(base)) return layout;

  const dir = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  const fresh: PaneNode = { type: "pane", id: newId, content };
  const root = mapPanes(base.root, p => {
    if (p.id !== paneId) return p;
    return { type: "split", id: `${newId}-split`, dir, children: before ? [fresh, p] : [p, fresh], sizes: [0.5, 0.5] };
  });
  return { root: root!, active: newId, maximised: null };
}

/** Shows `content` in a pane (a thread open elsewhere moves here). */
export function replacePane(layout: SplitLayout, paneId: string, content: PaneContent): SplitLayout {
  const target = findPane(layout, paneId);
  if (!target) return layout;
  if (sameContent(target.content, content)) return { ...layout, active: paneId };
  const elsewhere = content.kind === "thread" ? paneForThread(layout, content.id) : undefined;
  const base = elsewhere ? closePane(layout, elsewhere.id) : layout;
  if (!base) return layout;
  const root = mapPanes(base.root, p => (p.id === paneId ? { ...p, content } : p));
  return { ...base, root: root!, active: paneId, maximised: base.maximised && base.maximised !== paneId ? null : base.maximised };
}

/** Opening a thread: focus the pane that has it, or show it in the active pane. */
export function showThread(layout: SplitLayout, content: Extract<PaneContent, { kind: "thread" }>): SplitLayout {
  const open = paneForThread(layout, content.id);
  if (open) return layout.active === open.id && (!layout.maximised || layout.maximised === open.id) ? layout : focusPane(layout, open.id);
  return replacePane(layout, layout.active, content);
}

/** Gives a pane the keyboard (a maximised pane gives way to it). */
export function focusPane(layout: SplitLayout, paneId: string): SplitLayout {
  if (!findPane(layout, paneId)) return layout;
  if (layout.active === paneId && (!layout.maximised || layout.maximised === paneId)) return layout;
  return { ...layout, active: paneId, maximised: layout.maximised && layout.maximised !== paneId ? paneId : layout.maximised };
}

/** Maximise a pane, or put it back. */
export function toggleMaximise(layout: SplitLayout, paneId: string): SplitLayout {
  if (!findPane(layout, paneId)) return layout;
  return { ...layout, active: paneId, maximised: layout.maximised === paneId ? null : paneId };
}

/** How many panes deep a node is along a direction: the fewest pane widths it can shrink to. */
function minSpan(node: LayoutNode, dir: "row" | "column"): number {
  if (node.type === "pane") return 1;
  const spans = node.children.map(c => minSpan(c, dir));
  return node.dir === dir ? spans.reduce((a, b) => a + b, 0) : Math.max(...spans);
}

/**
 * Moves the divider after child `index` of a split by `deltaPx`, where the split is
 * `totalPx` long. Neither side gets smaller than its panes allow (`minPx` each).
 */
export function resizeSplit(layout: SplitLayout, splitId: string, index: number, deltaPx: number, totalPx: number, minPx = MIN_PANE_PX): SplitLayout {
  if (totalPx <= 0) return layout;
  let changed = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") return node;
    if (node.id !== splitId) {
      const children = node.children.map(walk);
      return children.some((c, i) => c !== node.children[i]) ? { ...node, children } : node;
    }
    const a = node.children[index];
    const b = node.children[index + 1];
    if (!a || !b) return node;
    const pair = node.sizes[index]! + node.sizes[index + 1]!;
    const minA = (minSpan(a, node.dir) * minPx) / totalPx;
    const minB = (minSpan(b, node.dir) * minPx) / totalPx;
    // Too small to honour both minimums: leave it.
    if (minA + minB > pair) return node;
    const nextA = Math.min(pair - minB, Math.max(minA, node.sizes[index]! + deltaPx / totalPx));
    if (Math.abs(nextA - node.sizes[index]!) < 1e-9) return node;
    changed = true;
    const sizes = [...node.sizes];
    sizes[index] = nextA;
    sizes[index + 1] = pair - nextA;
    return { ...node, sizes };
  };
  const root = walk(layout.root);
  return changed ? { ...layout, root } : layout;
}

/** Puts every divider in a split back to equal shares. */
export function evenSplit(layout: SplitLayout, splitId: string): SplitLayout {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") return node;
    if (node.id === splitId) return { ...node, sizes: node.children.map(() => 1 / node.children.length) };
    return { ...node, children: node.children.map(walk) };
  };
  return { ...layout, root: walk(layout.root) };
}

/** Removes panes whose content `keep` turns down. Null when none are left. */
export function pruneLayout(layout: SplitLayout, keep: (content: PaneContent) => boolean): SplitLayout | null {
  let next: SplitLayout | null = layout;
  for (const p of panes(layout)) if (next && !keep(p.content)) next = closePane(next, p.id);
  return next;
}

// ── Geometry ─────────────────────────────────────────────

/** A box as shares of the whole area (0–1). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Divider {
  splitId: string;
  index: number;
  dir: "row" | "column";
  /** Where the line is: x for a row split, y for a column split (0–1). */
  at: number;
  /** The span it runs along: the split's own box. */
  box: Box;
}

/** Where each pane and divider sits, as shares of the whole area. */
export function layoutBoxes(layout: SplitLayout): { panes: { id: string; box: Box }[]; dividers: Divider[] } {
  const out = { panes: [] as { id: string; box: Box }[], dividers: [] as Divider[] };
  const walk = (node: LayoutNode, box: Box) => {
    if (node.type === "pane") return void out.panes.push({ id: node.id, box });
    let offset = 0;
    node.children.forEach((c, i) => {
      const share = node.sizes[i]!;
      const child: Box =
        node.dir === "row"
          ? { x: box.x + offset * box.w, y: box.y, w: share * box.w, h: box.h }
          : { x: box.x, y: box.y + offset * box.h, w: box.w, h: share * box.h };
      offset += share;
      if (i < node.children.length - 1)
        out.dividers.push({ splitId: node.id, index: i, dir: node.dir, at: node.dir === "row" ? box.x + offset * box.w : box.y + offset * box.h, box });
      walk(c, child);
    });
  };
  walk(layout.root, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

/**
 * Where a dragged thread would land on a pane: near an edge splits that side, the
 * middle replaces it. `edge` is how far in (a share of the pane's size) the edge zones
 * reach. When the layout is full, everything is the middle.
 */
export function dropZoneAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, splittable = true, edge = 0.25): DropZone {
  if (!splittable || rect.width <= 0 || rect.height <= 0) return "center";
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const distances: [Side, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [side, d] = distances.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return d < edge ? side : "center";
}

// ── Keeping it between launches ──────────────────────────

const Content = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), mode: z.enum(["local", "cloud"]), id: z.string().min(1) }),
  z.object({ kind: z.literal("new") }),
]);
const Node: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("pane"), id: z.string().min(1), content: Content }),
    z.object({
      type: z.literal("split"),
      id: z.string().min(1),
      dir: z.enum(["row", "column"]),
      children: z.array(Node).min(1),
      sizes: z.array(z.number().positive()),
    }),
  ]),
);
const Stored = z.object({ root: Node, active: z.string(), maximised: z.string().nullable().default(null) });

/** A stored layout, checked and tidied; null if it's unusable. */
export function parseLayout(raw: unknown): SplitLayout | null {
  const r = Stored.safeParse(raw);
  if (!r.success) return null;
  const seenIds = new Set<string>();
  const seenThreads = new Set<string>();
  let ok = true;
  const check = (node: LayoutNode) => {
    if (seenIds.has(node.id)) ok = false;
    seenIds.add(node.id);
    if (node.type === "split") {
      if (node.sizes.length !== node.children.length) ok = false;
      node.children.forEach(check);
    }
  };
  check(r.data.root);
  if (!ok) return null;
  // Repeated threads and anything over the limit are dropped; shares are evened back to 1.
  let count = 0;
  const root = mapPanes(r.data.root, p => {
    if (p.content.kind === "thread") {
      if (seenThreads.has(p.content.id)) return null;
      seenThreads.add(p.content.id);
    }
    return ++count > MAX_PANES ? null : p;
  });
  if (!root) return null;
  const left = panes(root);
  const active = left.some(p => p.id === r.data.active) ? r.data.active : left[0]!.id;
  const maximised = r.data.maximised && left.some(p => p.id === r.data.maximised) ? r.data.maximised : null;
  return { root, active, maximised };
}

/**
 * The layout to start with: the stored one, without threads that no longer exist
 * (`exists` says; undefined means "can't tell yet", which keeps it). Null when fewer
 * than two panes are left, since one pane is just the normal thread view.
 */
export function restoreLayout(raw: unknown, exists: (c: Extract<PaneContent, { kind: "thread" }>) => boolean | undefined): SplitLayout | null {
  const parsed = parseLayout(raw);
  if (!parsed) return null;
  const kept = pruneLayout(parsed, c => c.kind !== "thread" || exists(c) !== false);
  return kept && panes(kept).length >= 2 ? kept : null;
}
