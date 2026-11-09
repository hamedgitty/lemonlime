/**
 * A very long paste (a log, a whole file) goes with the message as a text file instead of
 * filling the box, where it would be slow to edit and could push the message past what the
 * runner takes. ⌘⇧V (Ctrl+Shift+V) still pastes it into the box as text.
 */

/** Pastes bigger than this (in UTF-8 bytes) become a file. */
export const PASTE_AS_FILE_BYTES = 32 * 1024;
/** The longest message the runner takes, in characters. */
export const MESSAGE_MAX_CHARS = 200_000;

const NAME = /^pasted-text(?:-(\d+))?\.txt$/;

export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Whether pasting `pasted` over `selected` characters of a box holding `current` characters
 * should attach it as a file.
 */
export function pasteBecomesFile(pasted: string, current: number, selected = 0): boolean {
  // Cheap checks first: a character is at most 3 UTF-8 bytes in a JS string's terms.
  if (pasted.length * 3 <= PASTE_AS_FILE_BYTES && current - selected + pasted.length <= MESSAGE_MAX_CHARS) return false;
  return current - selected + pasted.length > MESSAGE_MAX_CHARS || utf8Bytes(pasted) > PASTE_AS_FILE_BYTES;
}

/** A name for the next pasted file that no attached file has: pasted-text.txt, pasted-text-2.txt… */
export function pastedTextName(taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has("pasted-text.txt")) return "pasted-text.txt";
  let n = 2;
  while (used.has(`pasted-text-${n}.txt`)) n++;
  return `pasted-text-${n}.txt`;
}

/** How to show an attached file's name: "Pasted text" (and its number) for pasted text, else the name. */
export function attachmentLabel(name: string): string {
  const m = NAME.exec(name);
  if (!m) return name;
  return m[1] ? `Pasted text ${m[1]}` : "Pasted text";
}

/** The pasted text as a file to attach. */
export const pastedTextFile = (text: string, taken: readonly string[]) => new File([text], pastedTextName(taken), { type: "text/plain" });
