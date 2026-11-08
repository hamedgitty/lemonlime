import { describe, expect, it } from "vitest";
import { applyPick, detectTrigger, insertQuote, quoteBlock, quotePath } from "../src/lib/composerTriggers.ts";
import { HISTORY_IDLE, stepHistory, uniquePrompts, type HistoryState } from "../src/lib/promptHistory.ts";
import { mergeCommands, pluginCommands } from "../src/lib/composerData.ts";

describe("composer triggers", () => {
  it("opens the command menu only for a slash at the start of the message", () => {
    expect(detectTrigger("/rev", 4)).toEqual({ kind: "command", query: "rev", start: 0, end: 4 });
    expect(detectTrigger("  /", 3)).toEqual({ kind: "command", query: "", start: 2, end: 3 });
    expect(detectTrigger("look at /rev", 12)).toBeNull();
    expect(detectTrigger("/usr/bin", 8)).toBeNull();
  });

  it("opens the file menu for @ anywhere, after a space", () => {
    expect(detectTrigger("fix @src/Bu", 11)).toEqual({ kind: "file", query: "src/Bu", start: 4, end: 11 });
    expect(detectTrigger("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
    expect(detectTrigger("mail me@example.com", 19)).toBeNull();
    // The caret has to be in the word, with nothing selected.
    expect(detectTrigger("fix @src done", 13)).toBeNull();
    expect(detectTrigger("fix @src", 8, 6)).toBeNull();
    expect(detectTrigger("", 0)).toBeNull();
  });

  it("puts the pick in place of what was typed", () => {
    const t = detectTrigger("/rev", 4)!;
    expect(applyPick("/rev", t, "review")).toEqual({ text: "/review ", caret: 8 });
    const f = detectTrigger("see @but and more", 8)!;
    expect(applyPick("see @but and more", f, "src/Button.tsx")).toEqual({ text: "see @src/Button.tsx and more", caret: 20 });
    expect(quotePath("My Docs/a b.md")).toBe('"My Docs/a b.md"');
  });

  it("quotes selected text as a Markdown block", () => {
    expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two\n\n");
    expect(insertQuote("", "hi")).toBe("> hi\n\n");
    expect(insertQuote("Earlier text  \n", "hi")).toBe("Earlier text\n\n> hi\n\n");
  });
});

describe("prompt history", () => {
  const prompts = ["first", "second", "third"];
  const box = (text: string, caret = text.length) => ({ text, caret });

  it("starts from an empty box and walks back, then forward to what was there", () => {
    let state: HistoryState = HISTORY_IDLE;
    const up1 = stepHistory(prompts, state, "up", box(""))!;
    expect(up1.text).toBe("third");
    state = up1.state;
    const up2 = stepHistory(prompts, state, "up", box("third", 0))!;
    expect(up2.text).toBe("second");
    state = up2.state;
    const up3 = stepHistory(prompts, state, "up", box("second", 0))!;
    expect(up3.text).toBe("first");
    // Nothing older: the key does its usual thing.
    expect(stepHistory(prompts, up3.state, "up", box("first", 0))).toBeNull();
    const down = stepHistory(prompts, up3.state, "down", box("first"))!;
    expect(down.text).toBe("second");
    const back = stepHistory(prompts, { index: 0, saved: "" }, "down", box("third"))!;
    expect(back).toEqual({ text: "", state: HISTORY_IDLE });
  });

  it("leaves a box with text in it alone", () => {
    expect(stepHistory(prompts, HISTORY_IDLE, "up", box("draft"))).toBeNull();
    expect(stepHistory(prompts, HISTORY_IDLE, "down", box(""))).toBeNull();
    expect(stepHistory([], HISTORY_IDLE, "up", box(""))).toBeNull();
  });

  it("moves the caret in a multi-line prompt until it reaches the edge", () => {
    const multi = ["one\ntwo", "three"];
    const s = { index: 1, saved: "" };
    expect(stepHistory(multi, s, "down", box("one\ntwo", 1))).toBeNull();
    expect(stepHistory(multi, s, "down", box("one\ntwo", 7))!.text).toBe("three");
  });

  it("stops browsing once the recalled prompt is edited", () => {
    expect(stepHistory(prompts, { index: 0, saved: "" }, "up", box("third, edited", 0))).toBeNull();
  });

  it("keeps each prompt once, newest copy", () => {
    expect(uniquePrompts(["a", "b", " a ", "", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("composer commands", () => {
  it("names plugin commands the way Claude Code does once installed", () => {
    const list = pluginCommands([
      { name: "tools", enabled: true, description: "", contents: { commands: ["review", "git/commit"] } },
      { name: "off", enabled: false, description: "", contents: { commands: ["x"] } },
    ]);
    expect(list.map(c => c.name)).toEqual(["tools:review", "tools:git:commit"]);
  });

  it("merges lists, first one with a name wins", () => {
    const merged = mergeCommands(
      [{ name: "review", description: "From the runner", source: "project" }],
      [
        { name: "review", description: "", source: "plugin" },
        { name: "alpha", description: "", source: "plugin" },
      ],
    );
    expect(merged).toEqual([
      { name: "alpha", description: "", source: "plugin" },
      { name: "review", description: "From the runner", source: "project" },
    ]);
  });
});
