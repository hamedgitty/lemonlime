import { describe, expect, it } from "vitest";
import {
  isTextField,
  isTypingKey,
  isUndoKey,
  liveUndo,
  popUndo,
  pushUndo,
  takeUndo,
  UNDO_KEEP_MS,
  UNDO_MAX,
  undoTakesOver,
  type UndoEntry,
} from "../src/lib/undo.ts";
import { IS_MAC } from "../src/lib/shortcuts.ts";

const entry = (id: number, at = 1000): UndoEntry => ({ id, label: `action ${id}`, at, undo: () => undefined });
const mod = IS_MAC ? { metaKey: true, ctrlKey: false } : { metaKey: false, ctrlKey: true };
const key = (k: string, o: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

describe("undo for sidebar actions", () => {
  it("undoes the newest first, one at a time", () => {
    let stack = pushUndo([], entry(1), 1000);
    stack = pushUndo(stack, entry(2), 1000);
    stack = pushUndo(stack, entry(3), 1000);
    const first = popUndo(stack, 1000);
    expect(first.entry?.id).toBe(3);
    const second = popUndo(first.stack, 1000);
    expect(second.entry?.id).toBe(2);
    expect(second.stack.map(e => e.id)).toEqual([1]);
    expect(popUndo([], 1000)).toEqual({ entry: null, stack: [] });
  });

  it("forgets actions after a while, and keeps only the last few", () => {
    const stack = [entry(1, 0), entry(2, UNDO_KEEP_MS)];
    expect(liveUndo(stack, UNDO_KEEP_MS + 1).map(e => e.id)).toEqual([2]);
    expect(popUndo([entry(1, 0)], UNDO_KEEP_MS).entry).toBeNull();
    let many: UndoEntry[] = [];
    for (let i = 0; i < UNDO_MAX + 5; i++) many = pushUndo(many, entry(i), 1000);
    expect(many).toHaveLength(UNDO_MAX);
    expect(many[0]!.id).toBe(5);
  });

  it("takes one action out by its own Undo button", () => {
    const { entry: taken, stack } = takeUndo([entry(1), entry(2)], 1);
    expect(taken?.id).toBe(1);
    expect(stack.map(e => e.id)).toEqual([2]);
    expect(takeUndo([entry(2)], 9).entry).toBeNull();
  });

  it("reads ⌘Z (Ctrl+Z) but not redo", () => {
    expect(isUndoKey(key("z", mod))).toBe(true);
    expect(isUndoKey(key("Z", mod))).toBe(true);
    expect(isUndoKey(key("z", { ...mod, shiftKey: true }))).toBe(false);
    expect(isUndoKey(key("z"))).toBe(false);
  });

  it("takes ⌘Z from a text field only before anything is typed there", () => {
    expect(undoTakesOver({ undoable: 1, inTextField: false, typedSinceAction: true })).toBe(true);
    expect(undoTakesOver({ undoable: 1, inTextField: true, typedSinceAction: false })).toBe(true);
    expect(undoTakesOver({ undoable: 1, inTextField: true, typedSinceAction: true })).toBe(false);
    expect(undoTakesOver({ undoable: 0, inTextField: false, typedSinceAction: false })).toBe(false);
  });

  it("counts typing and pasting, not modifiers or shortcuts", () => {
    expect(isTypingKey(key("a"))).toBe(true);
    expect(isTypingKey(key("Backspace"))).toBe(true);
    expect(isTypingKey(key("v", mod))).toBe(true);
    expect(isTypingKey(key("Meta", mod))).toBe(false);
    expect(isTypingKey(key("Shift"))).toBe(false);
    expect(isTypingKey(key("k", mod))).toBe(false);
  });

  it("knows where text is typed", () => {
    const el = (tagName: string, o: { type?: string; editable?: boolean; role?: string } = {}) =>
      ({
        tagName,
        type: o.type ?? "",
        isContentEditable: o.editable ?? false,
        getAttribute: (n: string) => (n === "role" ? (o.role ?? null) : null),
      }) as unknown as Element;
    expect(isTextField(el("TEXTAREA"))).toBe(true);
    expect(isTextField(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextField(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextField(el("DIV", { editable: true }))).toBe(true);
    expect(isTextField(el("BUTTON"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});
