/**
 * Links in terminal output: web addresses, and `path:line` places in the project that
 * open in a file tab (`src/app.ts:12`, `./lib/a.js:3:9`, `src/a.ts(12,5)`). Positions are
 * character offsets in the text searched; `end` is just past the link.
 */

export type TerminalLink =
  | { kind: "url"; start: number; end: number; text: string; url: string }
  | { kind: "path"; start: number; end: number; text: string; path: string; line: number; column?: number };

const URL_RE = /\bhttps?:\/\/[^\s"'`<>]+/gi;
// A path with at least one dot in its last part, then :line[:col] or (line,col).
const PATH_RE = /(?:\.{1,2}\/|~\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]+(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))/g;

/** Trailing punctuation that ends a sentence rather than the address, unless it closes a bracket the address opened. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (!last) return url;
    if (".,;:!?'\"".includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const open = pairs[last];
    if (open && url.split(open).length - 1 < url.split(last).length - 1) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

export function findTerminalLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length <= "https://".length) continue;
    links.push({ kind: "url", start: m.index, end: m.index + url.length, text: url, url });
  }
  const inUrl = (at: number) => links.some(l => at >= l.start && at < l.end);
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index;
    if (inUrl(start)) continue;
    // Part of a longer word (`foo=bar.ts:1` is fine, `x://a.ts:1` isn't).
    const before = text[start - 1];
    if (before && /[\w:/.~-]/.test(before)) continue;
    const whole = m[0];
    const line = Number(m[1] ?? m[3]);
    const col = m[2] ?? m[4];
    if (!Number.isFinite(line) || line < 1) continue;
    const path = whole.slice(0, whole.search(/:\d|\(\d/));
    links.push({ kind: "path", start, end: start + whole.length, text: whole, path, line, ...(col ? { column: Number(col) } : {}) });
  }
  return links.sort((a, b) => a.start - b.start);
}

/**
 * The project path a terminal path points at, for asking the runner: `./a` and `a` are the
 * same, a path from the home folder can't be checked, and an absolute one is sent as it is
 * (the runner answers only for files inside the thread's folder).
 */
export function projectPathCandidate(path: string): string | null {
  if (path.startsWith("~")) return null;
  let p = path;
  while (p.startsWith("./")) p = p.slice(2);
  return p || null;
}
