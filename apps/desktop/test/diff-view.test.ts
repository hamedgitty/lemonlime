import { describe, expect, it } from "vitest";
import { buildFileTree, diffSides, highlightedDiffLines, isTestFile, splitHighlightedLines, treeFolders } from "../src/lib/diffView.ts";
import type { HlNode } from "../src/lib/highlightGrammars.ts";
import type { ReviewLine } from "../src/lib/review.ts";

describe("isTestFile", () => {
  it("knows the usual test layouts", () => {
    for (const p of ["src/a.test.ts", "a.spec.tsx", "test/x.ts", "pkg/__tests__/y.js", "x_test.go", "test_x.py", "AppTests.swift", "a/__snapshots__/b.snap"])
      expect(isTestFile(p), p).toBe(true);
    for (const p of ["src/app.ts", "src/testing.ts", "contest/a.ts", "latest.json"]) expect(isTestFile(p), p).toBe(false);
  });
});

describe("buildFileTree", () => {
  it("groups files in folders, folders first, and joins single-child folders", () => {
    const tree = buildFileTree([{ path: "src/components/b.tsx" }, { path: "src/components/a.tsx" }, { path: "README.md" }, { path: "src/lib/x.ts" }]);
    expect(tree.map(n => n.name)).toEqual(["src", "README.md"]);
    const src = tree[0]!;
    expect(src.kind === "dir" && src.children.map(n => `${n.kind}:${n.path}`)).toEqual(["dir:src/components", "dir:src/lib"]);
    expect(treeFolders(tree)).toEqual(["src", "src/components", "src/lib"]);
    const deep = buildFileTree([{ path: "a/b/c/d.ts" }]);
    expect(deep).toMatchObject([{ kind: "dir", name: "a/b/c", path: "a/b/c", children: [{ kind: "file", name: "d.ts", path: "a/b/c/d.ts" }] }]);
  });
});

const L = (kind: ReviewLine["kind"], text: string): ReviewLine => ({ kind, text, oldNo: null, newNo: null });

describe("diff highlighting", () => {
  it("splits each side's highlighted code back into lines", () => {
    const nodes: HlNode[] = [
      { type: "element", className: ["token", "comment"], children: [{ type: "text", value: "/* a\nb */" }] },
      { type: "text", value: " x\ny" },
    ];
    expect(splitHighlightedLines(nodes)).toEqual([
      [{ type: "element", className: ["token", "comment"], children: [{ type: "text", value: "/* a" }] }],
      [
        { type: "element", className: ["token", "comment"], children: [{ type: "text", value: "b */" }] },
        { type: "text", value: " x" },
      ],
      [{ type: "text", value: "y" }],
    ]);
  });

  it("puts old and new side lines back in diff order", () => {
    const lines = [L("context", "a"), L("del", "b"), L("add", "B"), L("note", "\\ No newline"), L("context", "c")];
    expect(diffSides(lines)).toEqual({ old: "a\nb\nc", new: "a\nB\nc" });
    const text = (s: string): HlNode[] => [{ type: "text", value: s }];
    const map = highlightedDiffLines(lines, [text("a"), text("b"), text("c")], [text("a"), text("B"), text("c")]);
    expect(lines.map(l => (map.get(l)?.[0] as { value: string } | undefined)?.value ?? null)).toEqual(["a", "b", "B", null, "c"]);
  });

  it("gives up on very long lines", () => {
    expect(diffSides([L("add", "x".repeat(5000))])).toBeNull();
  });
});
