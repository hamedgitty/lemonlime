import { describe, expect, it } from "vitest";
import { parseBlocks, splitFrontMatter } from "../src/lib/markdown.tsx";
import { comboOf, keysFor, validCombo } from "../src/lib/shortcuts.ts";
import { compareVersions } from "../src/lib/system.ts";

describe("shortcuts", () => {
  const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("names a keypress the same way whatever shift turns the key into", () => {
    const mod = /Mac/.test(navigator.userAgent) ? { metaKey: true } : { ctrlKey: true };
    expect(comboOf(key("{", { ...mod, shiftKey: true }))).toBe("mod+shift+[");
    expect(comboOf(key("K", mod))).toBe("mod+k");
    expect(comboOf(key("Shift", { shiftKey: true }))).toBeNull();
  });

  it("lets people override and turn shortcuts off", () => {
    expect(keysFor("new-thread", {})).toBe("mod+n");
    expect(keysFor("new-thread", { "new-thread": "mod+shift+n" })).toBe("mod+shift+n");
    expect(keysFor("new-thread", { "new-thread": "" })).toBe("");
  });

  it("never accepts a combo plain typing could set off", () => {
    expect(validCombo("a")).toBe(false);
    expect(validCombo("shift+a")).toBe(false);
    expect(validCombo("mod+a")).toBe(true);
    expect(validCombo("alt+shift+p")).toBe(true);
  });
});

describe("versions", () => {
  it("compares numerically", () => {
    expect(compareVersions("2.1.10", "2.1.9")).toBe(1);
    expect(compareVersions("0.167.0", "0.167.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBe(-1);
  });
});

describe("markdown", () => {
  it("splits front matter from the body", () => {
    const fm = splitFrontMatter('---\nname: review\ndescription: "Reviews PRs"\n---\n# Steps\n');
    expect(fm.fields).toEqual([
      ["name", "review"],
      ["description", "Reviews PRs"],
    ]);
    expect(fm.body).toBe("# Steps\n");
  });

  it("reads the blocks skill docs use", () => {
    const blocks = parseBlocks("# Title\n\nSome text\nmore.\n\n- one\n- two\n\n```sh\nls\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> note");
    expect(blocks.map(b => b.kind)).toEqual(["heading", "para", "list", "code", "table", "quote"]);
    expect(blocks[1]).toEqual({ kind: "para", text: "Some text more." });
    expect(blocks[3]).toEqual({ kind: "code", lang: "sh", text: "ls" });
    expect(blocks[4]).toEqual({ kind: "table", head: ["a", "b"], rows: [["1", "2"]] });
  });
});
