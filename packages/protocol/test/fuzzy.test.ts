import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch, fuzzyMatchPath, highlightRuns } from "../src/fuzzy.ts";

describe("fuzzy matching", () => {
  it("needs every letter, in order, ignoring case", () => {
    expect(fuzzyMatch("nwt", "New thread")).not.toBeNull();
    expect(fuzzyMatch("NEW", "new thread")).not.toBeNull();
    expect(fuzzyMatch("twn", "New thread")).toBeNull();
    expect(fuzzyMatch("threads", "thread")).toBeNull();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("says which letters matched, preferring the starts of words", () => {
    expect(fuzzyMatch("nt", "New thread")!.positions).toEqual([0, 4]);
    expect(fuzzyMatch("set", "Open settings")!.positions).toEqual([5, 6, 7]);
  });

  it("ranks runs and word starts above scattered letters", () => {
    const a = fuzzyMatch("side", "Toggle side panel")!.score;
    const b = fuzzyMatch("side", "Show inline diff editor")!.score;
    expect(a).toBeGreaterThan(b);
  });

  it("prefers matches in the file name for paths", () => {
    const ranked = fuzzyFilter(["src/but/test.ts", "src/components/Button.tsx", "docs/about.md"], "butt", p => p, { paths: true });
    expect(ranked[0]!.item).toBe("src/components/Button.tsx");
    const m = fuzzyMatchPath("butt", "src/components/Button.tsx")!;
    expect(m.positions).toEqual([15, 16, 17, 18]);
  });

  it("keeps the original order for ties and respects the limit", () => {
    const ranked = fuzzyFilter(["alpha", "beta", "gamma", "delta"], "", s => s, { limit: 2 });
    expect(ranked.map(r => r.item)).toEqual(["alpha", "beta"]);
    expect(fuzzyFilter(["alpha", "beta"], "zz", s => s)).toEqual([]);
  });

  it("splits text into highlighted runs", () => {
    expect(highlightRuns("New thread", [0, 4, 5])).toEqual([
      { text: "N", hit: true },
      { text: "ew ", hit: false },
      { text: "th", hit: true },
      { text: "read", hit: false },
    ]);
    expect(highlightRuns("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });

  it("copes with very long texts", () => {
    const long = `${"x".repeat(2000)}needle`;
    expect(fuzzyMatch("needle", long)!.positions).toEqual([2000, 2001, 2002, 2003, 2004, 2005]);
  });
});
