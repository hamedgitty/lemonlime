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

  it("leaves AltGr alone, which types characters on many keyboards", () => {
    const altGr = { ...key("q", { ctrlKey: true, altKey: true }), getModifierState: (name: string) => name === "AltGraph" };
    expect(comboOf(altGr)).toBeNull();
    const plain = { ...key("q", { ctrlKey: true, altKey: true }), getModifierState: () => false };
    expect(comboOf(plain)).not.toBeNull();
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

describe("folding finished turns", async () => {
  const { foldFinishedTurns } = await import("../src/lib/timeline.ts");
  const at = "2026-11-07T00:00:00.000Z";
  const user = (n: number) => ({ kind: "user", key: `u${n}`, seq: n, at, text: "do it" }) as never;
  const agent = (n: number) => ({ kind: "agent", key: `a${n}`, seq: n, at, text: "done", streaming: false }) as never;
  const tool = (n: number) => ({ kind: "tool", key: `t${n}`, seq: n, at }) as never;

  it("folds the steps of every turn but the last, keeping the final answer", () => {
    const out = foldFinishedTurns([user(1), tool(2), agent(3), tool(4), agent(5), user(6), tool(7), agent(8)]);
    expect(out.map(i => (i as { kind: string }).kind)).toEqual(["user", "fold", "agent", "user", "tool", "agent"]);
    expect((out[1] as { items: unknown[] }).items).toHaveLength(3);
  });

  it("leaves a single turn alone", () => {
    expect(foldFinishedTurns([user(1), tool(2), agent(3)])).toHaveLength(3);
  });
});

describe("side panel addresses", async () => {
  const { normalizeUrl } = await import("../src/components/GlobalPanel.tsx");
  it("fills in the scheme the way people expect", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeUrl("127.0.0.1:5173/app")).toBe("http://127.0.0.1:5173/app");
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl("javascript:alert(1)")?.startsWith("https://")).not.toBe(false);
    expect(normalizeUrl("file:///etc/passwd")).toMatch(/^https:/);
    expect(normalizeUrl("")).toBeNull();
  });
});
