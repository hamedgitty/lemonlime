import { IS_MAC } from "./shortcuts.ts";

/**
 * ⌘Z (Ctrl+Z) for the sidebar's quick actions: archive, pin and mark as unread. Each one is
 * remembered with how to put it back; ⌘Z takes the newest first, one at a time. It only
 * takes the key from a text field when nothing has been typed there since the action, so
 * undoing your own typing still works.
 */

export interface UndoEntry {
  id: number;
  /** What was done, said in the sidebar's footer ("Archived “Fix login”"). */
  label: string;
  /** A line more, the first time something needs explaining. */
  detail?: string;
  at: number;
  undo: () => void;
}

/** How long an action stays undoable, and how many are kept. */
export const UNDO_KEEP_MS = 10 * 60_000;
export const UNDO_MAX = 20;

/** The entries still undoable at `now`, oldest first. */
export function liveUndo(stack: readonly UndoEntry[], now: number): UndoEntry[] {
  return stack.filter(e => now - e.at < UNDO_KEEP_MS);
}

export function pushUndo(stack: readonly UndoEntry[], entry: UndoEntry, now: number): UndoEntry[] {
  return [...liveUndo(stack, now), entry].slice(-UNDO_MAX);
}

/** The newest undoable entry, and the stack without it. */
export function popUndo(stack: readonly UndoEntry[], now: number): { entry: UndoEntry | null; stack: UndoEntry[] } {
  const live = liveUndo(stack, now);
  const entry = live.pop() ?? null;
  return { entry, stack: live };
}

/** Takes one entry out (its own Undo button was pressed). */
export function takeUndo(stack: readonly UndoEntry[], id: number): { entry: UndoEntry | null; stack: UndoEntry[] } {
  const entry = stack.find(e => e.id === id) ?? null;
  return { entry, stack: stack.filter(e => e.id !== id) };
}

/** ⌘Z (Ctrl+Z elsewhere), without Shift (redo) or Alt. */
export function isUndoKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return e.key.toLowerCase() === "z" && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.shiftKey && !e.altKey;
}

/** A key that types or edits, as opposed to a modifier pressed on its own or a shortcut. */
export function isTypingKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  if (["Meta", "Control", "Shift", "Alt", "CapsLock", "Tab", "Escape"].includes(e.key)) return false;
  // ⌘V pastes, so it counts; other ⌘ combos are shortcuts.
  if (IS_MAC ? e.metaKey : e.ctrlKey) return e.key.toLowerCase() === "v" || e.key.toLowerCase() === "x";
  return true;
}

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", "datetime-local", "date", "time"]);

/** Whether an element is somewhere text is typed (where ⌘Z means undo typing). */
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TEXT_INPUTS.has(((el as HTMLInputElement).type || "text").toLowerCase());
  return (el as HTMLElement).isContentEditable === true || el.getAttribute("role") === "textbox";
}

/** Whether ⌘Z undoes the last sidebar action rather than going to the focused field. */
export function undoTakesOver(o: { undoable: number; inTextField: boolean; typedSinceAction: boolean }): boolean {
  if (o.undoable === 0) return false;
  return !o.inTextField || !o.typedSinceAction;
}
