import type { FolderEntry } from "@lemonlime/protocol";

/**
 * The Files tab's tree: folders load one at a time as they're opened, and the rows on screen
 * are the loaded folders walked in order, skipping closed ones.
 */

/** A folder's listing: its entries, still loading, or why it failed. */
export type Listing = FolderEntry[] | "loading" | { error: string };

export interface TreeRow {
  /** Relative to the working directory, with "/" between parts. */
  path: string;
  name: string;
  dir: boolean;
  /** 0 for the top folder's entries. */
  depth: number;
  /** For an open folder whose listing hasn't come back yet. */
  loading?: boolean;
}

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The rows to show, top to bottom. */
export function treeRows(listings: ReadonlyMap<string, Listing>, open: ReadonlySet<string>, dir = "", depth = 0): TreeRow[] {
  const listing = listings.get(dir);
  if (!Array.isArray(listing)) return [];
  const rows: TreeRow[] = [];
  for (const e of listing) {
    const path = joinPath(dir, e.name);
    const isOpen = e.dir && open.has(path);
    rows.push({ path, name: e.name, dir: e.dir, depth, ...(isOpen && listings.get(path) === "loading" ? { loading: true } : {}) });
    if (isOpen) rows.push(...treeRows(listings, open, path, depth + 1));
  }
  return rows;
}

/**
 * What a key does in the tree from the row at `at`: move to another row, or open or close a
 * folder. Null when the key does nothing there.
 */
export function treeKey(rows: readonly TreeRow[], open: ReadonlySet<string>, at: number, key: string): { focus: number } | { toggle: string } | null {
  const row = rows[at];
  if (!row) return null;
  const to = (i: number) => (i >= 0 && i < rows.length && i !== at ? { focus: i } : null);
  if (key === "ArrowDown") return to(at + 1);
  if (key === "ArrowUp") return to(at - 1);
  if (key === "Home") return to(0);
  if (key === "End") return to(rows.length - 1);
  if (key === "ArrowRight") {
    if (!row.dir) return null;
    if (!open.has(row.path)) return { toggle: row.path };
    // Into an open folder: its first entry, once it has one.
    return (rows[at + 1]?.depth ?? 0) > row.depth ? { focus: at + 1 } : null;
  }
  if (key === "ArrowLeft") {
    if (row.dir && open.has(row.path)) return { toggle: row.path };
    // Out to the folder this row is in.
    for (let i = at - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) return { focus: i };
  }
  return null;
}

/** Every folder above `path`, so it can be opened down to that file. */
export function parentsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

const CODE = new Set(
  "ts tsx js jsx mjs cjs json jsonc yaml yml toml rs go py rb java kt swift c h cc cpp hpp cs php sh bash zsh css scss html vue svelte sql lua xml".split(" "),
);
const PROSE = new Set(["md", "mdx", "txt", "rst"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"]);

/** Which icon a file gets in the tree. */
export function fileKind(name: string): "code" | "prose" | "image" | "other" {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CODE.has(ext) ? "code" : PROSE.has(ext) ? "prose" : IMAGE.has(ext) ? "image" : "other";
}
