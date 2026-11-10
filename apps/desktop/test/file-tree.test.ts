import { describe, expect, it } from "vitest";
import { fileKind, parentsOf, treeKey, treeRows, type Listing } from "../src/lib/fileTree.ts";

describe("the Files tab tree", () => {
  const listings = new Map<string, Listing>([
    [
      "",
      [
        { name: "src", dir: true },
        { name: "docs", dir: true },
        { name: "README.md", dir: false },
      ],
    ],
    [
      "src",
      [
        { name: "lib", dir: true },
        { name: "main.ts", dir: false },
      ],
    ],
    ["src/lib", "loading"],
  ]);

  it("shows open folders' contents under them, indented", () => {
    expect(treeRows(listings, new Set()).map(r => r.path)).toEqual(["src", "docs", "README.md"]);
    const rows = treeRows(listings, new Set(["src", "src/lib"]));
    expect(rows.map(r => [r.path, r.depth])).toEqual([
      ["src", 0],
      ["src/lib", 1],
      ["src/main.ts", 1],
      ["docs", 0],
      ["README.md", 0],
    ]);
    expect(rows[1]!.loading).toBe(true);
  });

  describe("with the keyboard", () => {
    const open = new Set(["src", "src/lib"]);
    // src, src/lib (still loading), src/main.ts, docs, README.md
    const rows = treeRows(listings, open);

    it("moves up and down, and to the first and last row", () => {
      expect(treeKey(rows, open, 0, "ArrowDown")).toEqual({ focus: 1 });
      expect(treeKey(rows, open, 2, "ArrowUp")).toEqual({ focus: 1 });
      expect(treeKey(rows, open, 1, "End")).toEqual({ focus: 4 });
      expect(treeKey(rows, open, 3, "Home")).toEqual({ focus: 0 });
    });

    it("stays put at either end", () => {
      expect(treeKey(rows, open, 0, "ArrowUp")).toBeNull();
      expect(treeKey(rows, open, 4, "ArrowDown")).toBeNull();
      expect(treeKey(rows, open, 0, "Home")).toBeNull();
      expect(treeKey(rows, open, 4, "End")).toBeNull();
    });

    it("opens a closed folder with Right, then steps into it", () => {
      expect(treeKey(rows, open, 3, "ArrowRight")).toEqual({ toggle: "docs" });
      expect(treeKey(rows, open, 0, "ArrowRight")).toEqual({ focus: 1 });
      // Open, but nothing is listed in it yet.
      expect(treeKey(rows, open, 1, "ArrowRight")).toBeNull();
      expect(treeKey(rows, open, 4, "ArrowRight")).toBeNull();
    });

    it("closes an open folder with Left, or goes out to the folder a row is in", () => {
      expect(treeKey(rows, open, 0, "ArrowLeft")).toEqual({ toggle: "src" });
      expect(treeKey(rows, open, 2, "ArrowLeft")).toEqual({ focus: 0 });
      expect(treeKey(rows, open, 3, "ArrowLeft")).toBeNull();
      expect(treeKey(rows, open, 4, "ArrowLeft")).toBeNull();
    });

    it("leaves other keys and missing rows alone", () => {
      expect(treeKey(rows, open, 0, "a")).toBeNull();
      expect(treeKey(rows, open, 0, "Enter")).toBeNull();
      expect(treeKey(rows, open, 9, "ArrowDown")).toBeNull();
      expect(treeKey([], open, 0, "ArrowDown")).toBeNull();
    });
  });

  it("opens every folder above a file", () => {
    expect(parentsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(parentsOf("c.ts")).toEqual([]);
  });

  it("picks an icon by extension", () => {
    expect(fileKind("App.tsx")).toBe("code");
    expect(fileKind("README.md")).toBe("prose");
    expect(fileKind("logo.PNG")).toBe("image");
    expect(fileKind(".gitignore")).toBe("other");
  });
});
