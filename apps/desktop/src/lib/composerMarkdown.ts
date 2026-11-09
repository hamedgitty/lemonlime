/**
 * Markdown typing aids for the message box, as pure text changes: continuing and ending
 * lists, indenting list items and code, and wrapping a selection in brackets or quotes.
 * Each returns the whole new text and selection (applied by the composer as one undoable
 * step), or null to let the key do what it usually does.
 */

export interface TextChange {
  text: string;
  selStart: number;
  selEnd: number;
}

const ITEM = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;

interface Item {
  indent: string;
  /** "-", "*", "+", or "" for an ordered item. */
  bullet: string;
  number: number | null;
  delimiter: string;
  task: boolean;
  /** Where the item's text starts, from the start of the line. */
  contentAt: number;
}

function parseItem(line: string): Item | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  const ordered = m[3] !== undefined;
  return {
    indent: m[1]!,
    bullet: ordered ? "" : m[2]!,
    number: ordered ? Number(m[3]) : null,
    delimiter: m[4] ?? "",
    task: Boolean(m[6]),
    contentAt: m[0].length,
  };
}

const lineStartAt = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEndAt = (text: string, pos: number) => {
  const i = text.indexOf("\n", pos);
  return i < 0 ? text.length : i;
};

const marker = (item: Item, number: number | null) =>
  `${item.indent}${item.number === null ? item.bullet : `${number}${item.delimiter}`} ${item.task ? "[ ] " : ""}`;

/** Is `pos` inside a ``` (or ~~~) code block that started earlier? */
export function insideCodeFence(text: string, pos: number): boolean {
  let open: string | null = null;
  for (const line of text.slice(0, lineStartAt(text, pos)).split("\n")) {
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1]!;
    else if (m[1]![0] === open[0] && m[1]!.length >= open.length && !line.trim().slice(m[1]!.length).trim()) open = null;
  }
  return open !== null;
}

/**
 * The newline key in a list item: a new item below with the same marker (the next number,
 * an empty checkbox), carrying the text after the caret; numbered items below are renumbered.
 * On an empty item it ends the list instead.
 */
export function continueList(text: string, selStart: number, selEnd: number): TextChange | null {
  const start = lineStartAt(text, selStart);
  if (selEnd > lineEndAt(text, selStart) || insideCodeFence(text, selStart)) return null;
  const line = text.slice(start, lineEndAt(text, selStart));
  const item = parseItem(line);
  if (!item || selStart - start < item.contentAt) return null;
  if (!line.slice(item.contentAt).trim()) return endList(text, selStart);
  const next = item.number === null ? null : item.number + 1;
  const insert = `\n${marker(item, next)}`;
  const caret = selStart + insert.length;
  const joined = text.slice(0, selStart) + insert + text.slice(selEnd);
  const renumbered = next === null ? joined : renumberBelow(joined, caret, item, next);
  return { text: renumbered, selStart: caret, selEnd: caret };
}

/** After an inserted item numbered `from`, the numbered items that follow at its depth count on from it. */
function renumberBelow(text: string, caret: number, item: Item, from: number): string {
  const lines = text.split("\n");
  let at = 0;
  let row = 0;
  while (row < lines.length && at + lines[row]!.length < caret) at += lines[row++]!.length + 1;
  let n = from;
  for (let i = row + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) break;
    const it = parseItem(l);
    if (it && it.indent.length < item.indent.length) break;
    if (it && it.indent === item.indent) {
      if (it.number === null) break;
      n++;
      lines[i] = l.replace(/^([ \t]*)\d+/, `$1${n}`);
      continue;
    }
    // Deeper items and wrapped lines belong to the item above; anything else ends the list.
    if (!it && !/^[ \t]/.test(l)) break;
  }
  return lines.join("\n");
}

/** Enter on an empty list item: drop its marker, leaving an empty line, which ends the list. */
export function endList(text: string, caret: number): TextChange | null {
  const start = lineStartAt(text, caret);
  const end = lineEndAt(text, caret);
  const line = text.slice(start, end);
  const item = parseItem(line);
  if (!item || line.slice(item.contentAt).trim() || insideCodeFence(text, caret)) return null;
  return { text: text.slice(0, start) + text.slice(end), selStart: start, selEnd: start };
}

/**
 * Tab and Shift+Tab: indent or outdent the list items the selection touches (every touched
 * line has to be one), or the lines of a code block. A caret inside a code block with nothing
 * selected gets two spaces.
 */
export function indentLines(text: string, selStart: number, selEnd: number, outdent: boolean): TextChange | null {
  const inFence = insideCodeFence(text, selStart);
  if (inFence && !outdent && selStart === selEnd) {
    const caret = selStart + 2;
    return { text: `${text.slice(0, selStart)}  ${text.slice(selEnd)}`, selStart: caret, selEnd: caret };
  }
  const from = lineStartAt(text, selStart);
  // A selection that ends at the very start of a line doesn't take that line along.
  const lastPos = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  const to = lineEndAt(text, lastPos);
  const lines = text.slice(from, to).split("\n");
  const items = lines.map(parseItem);
  if (!inFence && items.some(i => !i)) return null;
  const deltas: number[] = [];
  const out = lines.map((line, i) => {
    const item = items[i];
    const unit = item?.number != null ? `${item.number}${item.delimiter} `.length : 2;
    if (!outdent) {
      deltas.push(unit);
      return " ".repeat(unit) + line;
    }
    const lead = /^( +|\t)/.exec(line)?.[1] ?? "";
    const cut = lead === "\t" ? 1 : Math.min(lead.length, unit);
    deltas.push(-cut);
    return line.slice(cut);
  });
  const before = lines.join("\n");
  const joined = out.join("\n");
  if (joined === before) return null;
  // Where a position lands once its line moved: with the text, but never left of the line's start.
  const map = (p: number) => {
    let old = from;
    let now = from;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]!.length;
      if (p <= old + len) return now + Math.max(0, p - old + deltas[i]!);
      old += len + 1;
      now += out[i]!.length + 1;
    }
    return p + joined.length - before.length;
  };
  return { text: text.slice(0, from) + joined + text.slice(to), selStart: map(selStart), selEnd: map(selEnd) };
}

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "`": "`", "*": "*", _: "_", '"': '"' };

/** Typing one of ( [ ` * _ " over selected text puts it around the selection, which stays selected. */
export function wrapSelection(text: string, selStart: number, selEnd: number, key: string): TextChange | null {
  const close = PAIRS[key];
  if (!close || selStart === selEnd) return null;
  return {
    text: text.slice(0, selStart) + key + text.slice(selStart, selEnd) + close + text.slice(selEnd),
    selStart: selStart + 1,
    selEnd: selEnd + 1,
  };
}
