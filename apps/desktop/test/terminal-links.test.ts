import { describe, expect, it } from "vitest";
import { findTerminalLinks, projectPathCandidate } from "../src/lib/terminalLinks.ts";
import { quoteTerminal } from "../src/lib/review.ts";

describe("findTerminalLinks", () => {
  it("finds web addresses without the punctuation after them", () => {
    const links = findTerminalLinks("  ➜  Local:   http://localhost:5173/, see (https://example.com/a_(b)).");
    expect(links.map(l => l.text)).toEqual(["http://localhost:5173/", "https://example.com/a_(b)"]);
    expect(links[0]).toMatchObject({ kind: "url", start: 14 });
  });

  it("finds path:line places in compiler and test output", () => {
    const links = findTerminalLinks("src/app.ts:12:5 - error TS2322, and ./lib/a.js:3 and pkg/x.test.ts(40,2)");
    expect(links).toEqual([
      { kind: "path", start: 0, end: 15, text: "src/app.ts:12:5", path: "src/app.ts", line: 12, column: 5 },
      { kind: "path", start: 36, end: 48, text: "./lib/a.js:3", path: "./lib/a.js", line: 3 },
      { kind: "path", start: 53, end: 72, text: "pkg/x.test.ts(40,2)", path: "pkg/x.test.ts", line: 40, column: 2 },
    ]);
  });

  it("ignores paths without a line, inside addresses, or line 0", () => {
    expect(findTerminalLinks("edited src/app.ts")).toEqual([]);
    expect(findTerminalLinks("http://host/a.ts:12").map(l => l.kind)).toEqual(["url"]);
    expect(findTerminalLinks("a.ts:0")).toEqual([]);
    expect(findTerminalLinks("at 10:30:12 today")).toEqual([]);
  });
});

describe("projectPathCandidate", () => {
  it("drops ./ and skips home-folder paths", () => {
    expect(projectPathCandidate("./src/a.ts")).toBe("src/a.ts");
    expect(projectPathCandidate("/Users/me/repo/a.ts")).toBe("/Users/me/repo/a.ts");
    expect(projectPathCandidate("~/x.ts")).toBeNull();
  });
});

describe("quoteTerminal", () => {
  it("fences the picked text, without trailing spaces", () => {
    expect(quoteTerminal("\n$ pnpm test   \nFAIL  a.test.ts  \n")).toBe("From the terminal:\n```text\n$ pnpm test\nFAIL  a.test.ts\n```\n");
    expect(quoteTerminal("   \n ")).toBe("");
  });
});
