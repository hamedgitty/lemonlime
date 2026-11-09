import { describe, expect, it } from "vitest";
import { fileKind, parentsOf, treeRows, type Listing } from "../src/lib/fileTree.ts";

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
