import { describe, expect, it } from "vitest";
import { continueList, endList, indentLines, insideCodeFence, wrapSelection, type TextChange } from "../src/lib/composerMarkdown.ts";
import { changedRange } from "../src/lib/textareaEdit.ts";

/** Text with a `|` for the caret (or two for a selection), as the helpers see it. */
const at = (marked: string): [string, number, number] => {
  const a = marked.indexOf("|");
  const b = marked.indexOf("|", a + 1);
  const text = marked.replace(/\|/g, "");
  return [text, a, b < 0 ? a : b - 1];
};
const show = (c: TextChange | null) => {
  if (!c) return null;
  const { text, selStart: a, selEnd: b } = c;
  return a === b ? `${text.slice(0, a)}|${text.slice(a)}` : `${text.slice(0, a)}|${text.slice(a, b)}|${text.slice(b)}`;
};

describe("continuing lists", () => {
  it("starts the next item with the same marker", () => {
    expect(show(continueList(...at("- one|")))).toBe("- one\n- |");
    expect(show(continueList(...at("  * one|")))).toBe("  * one\n  * |");
    expect(show(continueList(...at("- [x] done|")))).toBe("- [x] done\n- [ ] |");
  });

  it("counts on and renumbers the numbered items below", () => {
    expect(show(continueList(...at("1. one|\n2. two\n3. three")))).toBe("1. one\n2. |\n3. two\n4. three");
    expect(show(continueList(...at("1) one|\n   wrapped\n2) two")))).toBe("1) one\n2) |\n   wrapped\n3) two");
    // A nested list and what follows the list are left alone.
    expect(show(continueList(...at("1. a|\n   - x\n2. b\n\n7. other")))).toBe("1. a\n2. |\n   - x\n3. b\n\n7. other");
  });

  it("moves the text after the caret into the new item", () => {
    expect(show(continueList(...at("- one |two")))).toBe("- one \n- |two");
  });

  it("ends the list on an empty item", () => {
    expect(show(continueList(...at("- one\n- |")))).toBe("- one\n|");
    expect(show(endList(...(at("- one\n  - |").slice(0, 2) as [string, number])))).toBe("- one\n|");
    expect(endList("- one", 5)).toBeNull();
  });

  it("does nothing outside a list, before the marker, or in code", () => {
    expect(continueList(...at("plain|"))).toBeNull();
    expect(continueList(...at("|- one"))).toBeNull();
    expect(continueList(...at("```\n- one|"))).toBeNull();
    expect(continueList(...at("-not a list|"))).toBeNull();
  });
});

describe("indenting", () => {
  it("indents and outdents list items, keeping the selection on the text", () => {
    expect(show(indentLines(...at("- one\n- tw|o"), false))).toBe("- one\n  - tw|o");
    expect(show(indentLines(...at("- one\n  - tw|o"), true))).toBe("- one\n- tw|o");
    expect(show(indentLines(...at("|- a\n- b|"), false))).toBe("  |- a\n  - b|");
    expect(show(indentLines(...at("1. a\n2. b|"), false))).toBe("1. a\n   2. b|");
  });

  it("leaves Tab alone outside lists and code", () => {
    expect(indentLines(...at("hello|"), false)).toBeNull();
    expect(indentLines(...at("|- a\nnot|"), false)).toBeNull();
    expect(indentLines(...at("- a|"), true)).toBeNull();
  });

  it("indents inside a code block", () => {
    expect(show(indentLines(...at("```\nif (x) {\n|"), false))).toBe("```\nif (x) {\n  |");
    expect(show(indentLines(...at("```\n|a\nb|\n```"), false))).toBe("```\n  |a\n  b|\n```");
    expect(show(indentLines(...at("```\n  a|"), true))).toBe("```\na|");
  });

  it("knows when the caret is in a code block", () => {
    expect(insideCodeFence("```ts\ncode", 8)).toBe(true);
    expect(insideCodeFence("```ts\ncode\n```\nafter", 18)).toBe(false);
    expect(insideCodeFence("no code", 3)).toBe(false);
  });
});

describe("wrapping a selection", () => {
  it("puts the pair around what's selected", () => {
    expect(show(wrapSelection(...at("say |hi| now"), "("))).toBe("say (|hi|) now");
    expect(show(wrapSelection(...at("|bold|"), "*"))).toBe("*|bold|*");
    expect(show(wrapSelection(...at("|x|"), '"'))).toBe('"|x|"');
    expect(wrapSelection(...at("no|selection"), "(")).toBeNull();
    expect(wrapSelection(...at("|x|"), "a")).toBeNull();
  });
});

describe("undoable edits", () => {
  it("replaces only the part that changed", () => {
    expect(changedRange("hello world", "hello there world")).toEqual({ start: 6, end: 6, insert: "there " });
    expect(changedRange("abc", "")).toEqual({ start: 0, end: 3, insert: "" });
    expect(changedRange("same", "same")).toEqual({ start: 4, end: 4, insert: "" });
    expect(changedRange("aaa", "aa")).toEqual({ start: 2, end: 3, insert: "" });
  });
});
