/**
 * The composer's typeahead: `/` at the start of a message picks one of the agent's slash
 * commands, `@` anywhere picks a file from the thread's repository. Pure helpers, so the
 * rules are easy to test.
 */

export interface Trigger {
  kind: "command" | "file";
  /** What was typed after the `/` or `@`. */
  query: string;
  /** Where the trigger character is. */
  start: number;
  /** The caret: the text from `start` to here is replaced on a pick. */
  end: number;
}

/** The trigger the caret is in, if any. Only a caret with nothing selected counts. */
export function detectTrigger(text: string, caret: number, selectionEnd = caret): Trigger | null {
  if (caret !== selectionEnd || caret < 1) return null;
  // The word the caret ends: back to the last space or line break.
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const word = text.slice(start, caret);
  if (word.length === 0) return null;
  if (word[0] === "/") {
    // Agents only treat a slash command as one when the message starts with it.
    if (text.slice(0, start).trim() !== "") return null;
    const query = word.slice(1);
    if (query.includes("/")) return null; // a path like /usr/bin, not a command
    return { kind: "command", query, start, end: caret };
  }
  if (word[0] === "@") {
    return { kind: "file", query: word.slice(1), start, end: caret };
  }
  return null;
}

/** Puts a picked command or file in place of the trigger; returns the new text and caret. */
export function applyPick(text: string, trigger: Trigger, value: string): { text: string; caret: number } {
  const insert = trigger.kind === "command" ? `/${value} ` : `@${quotePath(value)} `;
  // Don't double the space if one already follows.
  const after = text.slice(trigger.end).replace(/^ /, "");
  const next = text.slice(0, trigger.start) + insert + after;
  return { text: next, caret: trigger.start + insert.length };
}

/** Paths with spaces go in quotes so the agent reads them as one. */
export function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/** Text quoted as a Markdown block (`> ` on every line), with a blank line after it. */
export function quoteBlock(selected: string): string {
  const lines = selected.replace(/\r\n/g, "\n").trim().split("\n");
  return `${lines.map(l => (l.trim() ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Adds a quote to what's already in the composer: at the end, on its own lines. */
export function insertQuote(current: string, selected: string): string {
  const block = quoteBlock(selected);
  if (!current.trim()) return block;
  return `${current.replace(/\s*$/, "")}\n\n${block}`;
}
