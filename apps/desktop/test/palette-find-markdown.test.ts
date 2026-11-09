import { describe, expect, it } from "vitest";
import { appCommands, parseQuery, rankPalette, type PaletteItem } from "../src/lib/palette.ts";
import { findOffsets, matchLabel, stepMatch } from "../src/lib/findInThread.ts";
import { splitMarkdownBlocks } from "../src/lib/markdownStreamBlocks.ts";
import { grammarFor, highlightCode, type HlNode } from "../src/lib/highlightGrammars.ts";
import { COMPOSER_SHORTCUTS, SHORTCUTS } from "../src/lib/shortcuts.ts";

const thread = (id: string, label: string, detail = "repo"): PaletteItem => ({ id: `thread:${id}`, section: "threads", label, detail });

describe("command palette", () => {
  const items: PaletteItem[] = [
    thread("a", "Fix the login page"),
    thread("b", "Add dark mode", "website"),
    { id: "project:/code/site", section: "projects", label: "site", detail: "/code/site" },
    ...appCommands([{ id: "darkroom", label: "Open the darkroom", keywords: "night photos" }]),
  ];

  it("turns every shortcut but its own into a command, with its keys", () => {
    const cmds = appCommands([]);
    // Less the palette's own and the ones that only work in the message box.
    expect(cmds.length).toBe(SHORTCUTS.length - 1 - COMPOSER_SHORTCUTS.length);
    expect(cmds.find(c => c.id === "command:new-thread")?.shortcut).toBe("new-thread");
    expect(cmds.some(c => c.id === "command:search")).toBe(false);
    expect(appCommands([], ["find"]).some(c => c.id === "command:find")).toBe(false);
  });

  it("reads > as commands only", () => {
    expect(parseQuery("> dark")).toEqual({ commandsOnly: true, query: "dark" });
    expect(parseQuery("dark ")).toEqual({ commandsOnly: false, query: "dark" });
  });

  it("finds threads, projects and commands, matched letters marked", () => {
    const groups = rankPalette(items, "dark", []);
    const ids = groups.flatMap(g => g.items.map(r => r.item.id));
    expect(ids).toContain("thread:b");
    expect(ids).toContain("command:darkroom");
    const b = groups.flatMap(g => g.items).find(r => r.item.id === "thread:b")!;
    expect(b.match.positions).toEqual([4, 5, 6, 7]);
    // A keyword match finds it too, without highlighting.
    const night = rankPalette(items, "night", []).flatMap(g => g.items);
    expect(night.map(r => r.item.id)).toEqual(["command:darkroom"]);
    expect(night[0]!.match.positions).toEqual([]);
  });

  it("searches only commands after >", () => {
    const groups = rankPalette(items, ">dark", []);
    expect(groups.map(g => g.section)).toEqual(["commands"]);
  });

  it("shows recent picks first", () => {
    const idle = rankPalette(items, "", ["thread:b", "gone", "command:darkroom"]);
    expect(idle[0]!.section).toBe("recent");
    expect(idle[0]!.items.map(r => r.item.id)).toEqual(["thread:b", "command:darkroom"]);
    // Not listed twice.
    expect(idle.find(g => g.section === "threads")!.items.map(r => r.item.id)).toEqual(["thread:a"]);
    // With a query, a recent pick ranks above an equally good match.
    const both = [thread("x", "Deploy notes"), thread("y", "Deploy notes")];
    expect(rankPalette(both, "deploy", ["thread:y"])[0]!.items[0]!.item.id).toBe("thread:y");
  });
});

describe("find in thread", () => {
  it("finds every match, ignoring case, without overlaps", () => {
    expect(findOffsets("Test the test of tests", "test")).toEqual([0, 9, 17]);
    expect(findOffsets("aaaa", "aa")).toEqual([0, 2]);
    expect(findOffsets("abc", "")).toEqual([]);
  });

  it("wraps round at either end and counts", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
    expect(matchLabel(2, 12, "x")).toBe("3 of 12");
    expect(matchLabel(-1, 0, "x")).toBe("No results");
    expect(matchLabel(-1, 0, "")).toBe("");
  });
});

describe("markdown while streaming", () => {
  it("cuts at blank lines between finished blocks", () => {
    expect(splitMarkdownBlocks("# Title\n\nFirst para.\n\nSecond")).toEqual(["# Title\n\n", "First para.\n\n", "Second"]);
  });

  it("keeps a code fence with blank lines in one piece", () => {
    const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    expect(splitMarkdownBlocks(text)).toEqual(["Intro\n\n", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n", "After"]);
  });

  it("keeps list items after blank lines together", () => {
    expect(splitMarkdownBlocks("- one\n\n- two\n\nDone")).toEqual(["- one\n\n- two\n\n", "Done"]);
  });

  it("gives up on syntax that ties blocks together", () => {
    expect(splitMarkdownBlocks("See [x][1].\n\n[1]: https://example.com")).toBeNull();
  });
});

describe("code highlighting", () => {
  const flat = (nodes: HlNode[]): string => nodes.map(n => (n.type === "text" ? n.value : flat(n.children))).join("");
  const classes = (nodes: HlNode[]): string[] => nodes.flatMap(n => (n.type === "text" ? [] : [...n.className, ...classes(n.children)]));

  it("knows common languages by their usual names", () => {
    expect(grammarFor("ts")).toBe("typescript");
    expect(grammarFor("Shell")).toBe("bash");
    expect(grammarFor("py")).toBe("python");
    expect(grammarFor("nonsense")).toBeNull();
    expect(grammarFor("")).toBeNull();
  });

  it("marks tokens and keeps the code exactly", () => {
    const code = "const greet = (name: string) => `hi ${name}`; // say hi";
    const nodes = highlightCode(code, "ts")!;
    expect(flat(nodes)).toBe(code);
    expect(classes(nodes)).toEqual(expect.arrayContaining(["token", "keyword", "comment"]));
    expect(highlightCode("x", "nonsense")).toBeNull();
  });
});
