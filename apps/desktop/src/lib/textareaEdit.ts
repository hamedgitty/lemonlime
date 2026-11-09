/**
 * Changing a text box's text the way typing does, so ⌘Z (Ctrl+Z) can undo it. Setting a
 * controlled textarea's value from React wipes the browser's undo history; inserting through
 * the editing commands keeps it, and fires the usual input event so React hears the change.
 */

/** The smallest range of `before` to replace, and with what, to get `after`. */
export function changedRange(before: string, after: string): { start: number; end: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < max - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  return { start, end: before.length - tail, insert: after.slice(start, after.length - tail) };
}

/**
 * Replaces `start`–`end` of the box's text with `text`, as one undoable step, and puts the
 * selection at `select` (the end of the new text by default). Focuses the box.
 */
export function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string, select?: readonly [number, number]): void {
  const before = el.value;
  if (!(start === end && text === "")) {
    el.focus();
    el.setSelectionRange(start, end);
    let done = false;
    try {
      done = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    } catch {
      done = false;
    }
    // A disabled box or an engine without the command: change it directly (no undo step).
    if (!done || el.value === before) {
      el.setRangeText(text, start, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const [a, b] = select ?? [start + text.length, start + text.length];
  el.setSelectionRange(a, b);
}

/** Makes the box's text `next`, changing only the part that differs, and puts the caret at `caret`. */
export function replaceValue(el: HTMLTextAreaElement, next: string, caret: number = next.length): void {
  const r = changedRange(el.value, next);
  replaceRange(el, r.start, r.end, r.insert, [caret, caret]);
}
