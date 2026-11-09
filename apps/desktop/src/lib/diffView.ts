import type { HlNode } from "./highlightGrammars.ts";
import type { ReviewLine } from "./review.ts";

/**
 * Helpers for the Changes tab: which files are tests, the changed files as a folder tree,
 * and syntax highlighting for diff lines (each side of the change highlighted as code, then
 * split back into lines).
 */

// ── Test files ─────────────────────────────────────────────

const TEST_FOLDERS = new Set(["test", "tests", "__tests__", "spec", "specs", "__mocks__", "e2e", "testdata", "fixtures"]);

/** Whether a path looks like a test, a test fixture or a snapshot, in the common layouts. */
export function isTestFile(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some(p => TEST_FOLDERS.has(p.toLowerCase()))) return true;
  return (
    /\.(test|spec|e2e|stories)\.[^.]+$/i.test(name) ||
    /\.snap$/i.test(name) ||
    /_test\.(go|py|rb|exs?|dart)$/i.test(name) ||
    /^test_.+\.py$/i.test(name) ||
    /(Tests?|Spec)\.(swift|kt|java|cs|scala)$/.test(name) ||
    /_spec\.rb$/i.test(name)
  );
}

// ── The file tree ──────────────────────────────────────────

export type FileTreeNode<F> = { kind: "dir"; name: string; path: string; children: FileTreeNode<F>[] } | { kind: "file"; name: string; path: string; file: F };

/**
 * The files as folders and files, folders first, each sorted by name. A folder holding just
 * one folder is shown as one ("src/components").
 */
export function buildFileTree<F extends { path: string }>(files: readonly F[]): FileTreeNode<F>[] {
  type Dir = { dirs: Map<string, Dir>; files: F[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let at = root;
    for (const p of parts.slice(0, -1)) {
      let next = at.dirs.get(p);
      if (!next) at.dirs.set(p, (next = { dirs: new Map(), files: [] }));
      at = next;
    }
    at.files.push(f);
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const walk = (dir: Dir, prefix: string): FileTreeNode<F>[] => {
    const dirs = [...dir.dirs.entries()].map(([name, d]): FileTreeNode<F> => {
      let label = name;
      let inner = d;
      while (inner.files.length === 0 && inner.dirs.size === 1) {
        const [childName, child] = [...inner.dirs.entries()][0]!;
        label = `${label}/${childName}`;
        inner = child;
      }
      const path = prefix ? `${prefix}/${label}` : label;
      return { kind: "dir", name: label, path, children: walk(inner, path) };
    });
    const leaves = dir.files.map((file): FileTreeNode<F> => ({ kind: "file", name: file.path.split("/").at(-1) ?? file.path, path: file.path, file }));
    return [...dirs.sort(byName), ...leaves.sort(byName)];
  };
  return walk(root, "");
}

/** Every folder path in the tree (to fold or unfold them all). */
export function treeFolders<F>(nodes: readonly FileTreeNode<F>[]): string[] {
  return nodes.flatMap(n => (n.kind === "dir" ? [n.path, ...treeFolders(n.children)] : []));
}

// ── Highlighting ───────────────────────────────────────────

/** Lines longer than this, or files with more text than `HIGHLIGHT_DIFF_MAX_CHARS`, show plain. */
export const HIGHLIGHT_LINE_MAX_CHARS = 1000;
export const HIGHLIGHT_DIFF_MAX_CHARS = 150_000;

/**
 * The old and new side of a file's changes as text, each line once: context and removed
 * lines are the old side, context and added lines the new. Null when it's too big to
 * highlight.
 */
export function diffSides(lines: readonly ReviewLine[]): { old: string; new: string } | null {
  const before: string[] = [];
  const after: string[] = [];
  let chars = 0;
  for (const l of lines) {
    if (l.kind === "note") continue;
    if (l.text.length > HIGHLIGHT_LINE_MAX_CHARS) return null;
    chars += l.text.length + 1;
    if (l.kind !== "add") before.push(l.text);
    if (l.kind !== "del") after.push(l.text);
  }
  if (chars > HIGHLIGHT_DIFF_MAX_CHARS) return null;
  return { old: before.join("\n"), new: after.join("\n") };
}

/** Highlighted code split at its line breaks, keeping each token's classes on every line it spans. */
export function splitHighlightedLines(nodes: readonly HlNode[]): HlNode[][] {
  const lines: HlNode[][] = [[]];
  const walk = (list: readonly HlNode[], into: () => HlNode[]) => {
    for (const n of list) {
      if (n.type === "text") {
        n.value.split("\n").forEach((piece, i) => {
          if (i > 0) lines.push([]);
          if (piece) into().push({ type: "text", value: piece });
        });
        continue;
      }
      // Each line the element spans gets its own copy of it, holding that line's part.
      const copies = new Map<number, HlNode[]>();
      walk(n.children, () => {
        const at = lines.length - 1;
        let kids = copies.get(at);
        if (!kids) {
          kids = [];
          copies.set(at, kids);
          into().push({ type: "element", className: n.className, children: kids });
        }
        return kids;
      });
    }
  };
  walk(nodes, () => lines[lines.length - 1]!);
  return lines;
}

/**
 * Highlighted nodes for each line of a file's diff, in the order of `lines`, from the two
 * sides highlighted on their own (see diffSides). Lines that can't be matched are left out.
 */
export function highlightedDiffLines(lines: readonly ReviewLine[], old: readonly HlNode[][], next: readonly HlNode[][]): Map<ReviewLine, HlNode[]> {
  const out = new Map<ReviewLine, HlNode[]>();
  let o = 0;
  let n = 0;
  for (const l of lines) {
    if (l.kind === "note") continue;
    if (l.kind === "del") {
      const h = old[o++];
      if (h) out.set(l, h);
    } else if (l.kind === "add") {
      const h = next[n++];
      if (h) out.set(l, h);
    } else {
      const h = next[n++];
      o++;
      if (h) out.set(l, h);
    }
  }
  return out;
}
