import { createContext, Fragment, memo, useContext, useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { Check, Copy, WrapText } from "lucide-react";
import { useHighlighted } from "./markdownHighlight.tsx";
import { splitMarkdownBlocks } from "./markdownStreamBlocks.ts";
import { fileRef, type FileRef } from "./filePaths.ts";

/**
 * A small Markdown renderer for skill and plugin docs and the agent's replies: headings,
 * paragraphs (with hard line breaks), nested lists with task boxes, nested quotes, fenced
 * code, tables, rules, and inline code, bold, italics, strikethrough and links. It builds
 * React elements, never HTML strings, so nothing in the text can run. Each block takes its
 * direction from its own text, so right-to-left writing reads right; code stays left to right.
 */

export interface FrontMatter {
  fields: [string, string][];
  body: string;
}

/** Splits `---` front matter (simple `key: value` lines) from the rest. */
export function splitFrontMatter(text: string): FrontMatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields: [string, string][] = [];
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && !/^\s/.test(line))
      fields.push([
        line.slice(0, i).trim(),
        line
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      ]);
  }
  return { fields, body: text.slice(m[0].length) };
}

export interface ListItem {
  /** A task box: true when ticked, false when not, null for a plain item. */
  task: boolean | null;
  blocks: Block[];
}

export type Block =
  | { kind: "heading"; level: number; text: string }
  /** Hard line breaks are kept as "\n"; soft ones are already spaces. */
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map(c => c.trim());

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const FENCE = /^(\s*)(```|~~~)\s*([\w+-]*)/;
const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;
/** Drops up to `n` columns of leading space. */
const dedent = (line: string, n: number) => {
  let i = 0;
  let col = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) col += line[i++] === "\t" ? 4 : 1;
  return line.slice(i);
};
/** A line that starts a block of its own, so it can't carry on a paragraph. */
const STARTS_BLOCK = /^(#{1,6}\s|```|~~~|\s*>|\s*([-*+]|\d{1,9}[.)])\s)/;

export function parseBlocks(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[2]!;
      const indent = fence[1]!.length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(dedent(lines[i++]!, indent));
      i++;
      out.push({ kind: "code", lang: fence[3] ?? "", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1]!.length, text: h[2]!.replace(/\s+#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      // Lines without ">" right after a quoted line carry its paragraph on.
      while (i < lines.length && (/^\s*>/.test(lines[i]!) || (lines[i]!.trim() && !STARTS_BLOCK.test(lines[i]!) && body.at(-1)?.trim())))
        body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", blocks: depth > 8 ? [{ kind: "para", text: body.join(" ") }] : parseBlocks(body.join("\n"), depth + 1) });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !STARTS_BLOCK.test(lines[i]!)) para.push(lines[i++]!);
    out.push({ kind: "para", text: joinParagraph(para) });
  }
  return out;
}

/** A paragraph's lines as one string: a line ending in two spaces or a backslash breaks there. */
function joinParagraph(lines: string[]): string {
  let text = "";
  lines.forEach((raw, n) => {
    const hard = /( {2,}|\\)$/.test(raw);
    const line = raw.trim().replace(/\\$/, "");
    text += line;
    if (n < lines.length - 1) text += hard ? "\n" : " ";
  });
  return text;
}

/**
 * A list from line `start`: its items, each with the lines indented under it (nested
 * lists, code, more paragraphs) parsed as blocks of their own. Returns where it ended.
 */
function parseList(lines: string[], start: number, depth: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = indentOf(lines[start]!);
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || indentOf(lines[i]!) !== indent || /\d/.test(m[2]!) !== ordered) break;
    // Where the item's text starts; lines under it indented this far (or past the marker) belong to it.
    const content = indent + m[2]!.length + Math.max(1, Math.min(m[3]!.length, 4));
    const body = [m[4]!];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        // A blank line stays in the item only if indented text follows.
        let j = i + 1;
        while (j < lines.length && !lines[j]!.trim()) j++;
        if (j < lines.length && indentOf(lines[j]!) > indent && !(LIST_ITEM.test(lines[j]!) && indentOf(lines[j]!) === indent)) {
          for (; i < j; i++) body.push("");
          continue;
        }
        break;
      }
      const deeper = indentOf(l) > indent;
      // A paragraph's wrapped lines carry on even when they aren't indented.
      const inCode = body.filter(b => FENCE.test(b)).length % 2 === 1;
      const lazy = !deeper && !inCode && !STARTS_BLOCK.test(l) && body.at(-1)?.trim();
      if (!deeper && !lazy) break;
      body.push(deeper ? dedent(l, Math.min(indentOf(l), content)) : l);
      i++;
    }
    const task = /^\[([ xX])\]\s+/.exec(body[0]!);
    if (task) body[0] = body[0]!.slice(task[0].length);
    items.push({ task: task ? task[1] !== " " : null, blocks: depth > 8 ? [{ kind: "para", text: body.join(" ") }] : parseBlocks(body.join("\n"), depth + 1) });
    // Blank lines between items of the same list keep it going.
    let j = i;
    while (j < lines.length && !lines[j]!.trim()) j++;
    if (j > i && j < lines.length) {
      const n = LIST_ITEM.exec(lines[j]!);
      if (n && indentOf(lines[j]!) === indent && /\d/.test(n[2]!) === ordered) i = j;
    }
  }
  return [{ kind: "list", ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items }, i];
}

/**
 * Lets inline code and links that name a file in the project open it (the thread provides
 * this around its timeline). `root` is the project folder, for absolute paths.
 */
export interface FileLinks {
  root?: string | null;
  open: (ref: FileRef) => void;
}
export const FileLinksContext = createContext<FileLinks | null>(null);

/**
 * Lets the place a reply is shown give its web links a right-click menu: it is handed the
 * address and the link's button, and returns the button wrapped in whatever opens the menu.
 */
export const LinkMenuContext = createContext<((url: string, link: ReactElement) => ReactNode) | null>(null);

/** `decodeURI`, except text that isn't valid (a lone "%") comes back as it was instead of throwing. */
const decoded = (url: string) => {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
};

const count = (text: string, ch: string) => text.split(ch).length - 1;

/**
 * A web address written out in a sentence, without the punctuation that belongs to the
 * sentence: "see https://example.com/a." links "https://example.com/a". A closing bracket
 * stays only when the address opened one, so "https://example.com/a_(b)" keeps its pair.
 */
export function trimBareUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const end = url.at(-1);
    if (end && ".,;:!?'\"*".includes(end)) url = url.slice(0, -1);
    else if (end === ")" && count(url, ")") > count(url, "(")) url = url.slice(0, -1);
    else if (end === "]" && count(url, "]") > count(url, "[")) url = url.slice(0, -1);
    else return url;
  }
}

/** Endings common enough that text like "github.com" is read as a site, not a file name. */
const SITE_ENDINGS = new Set(["com", "org", "net", "io", "dev", "app", "ai", "co", "gov", "edu"]);

/**
 * The site a link really opens, when its text names a different one. "[github.com](https://example.net)"
 * reads as one site and opens another, so the real one is shown beside it. Null when the text
 * isn't an address or names the same site.
 */
export function mismatchedHost(label: string, url: string): string | null {
  let target: string;
  try {
    target = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const m = /^\s*(https?:\/\/)?((?:[a-z0-9-]+\.)+([a-z]{2,}))(?::\d+)?(?:[/?#]\S*)?\s*$/i.exec(label);
  if (!m) return null;
  const shown = m[2]!.toLowerCase();
  if (!m[1] && !shown.startsWith("www.") && !SITE_ENDINGS.has(m[3]!.toLowerCase())) return null;
  const bare = (host: string) => host.replace(/^www\./, "");
  return bare(shown) === bare(target) ? null : target;
}

/**
 * Inline: `code`, **bold**, *italic*, ~~struck~~, [text](https://…), a web address written
 * out as it is, and hard line breaks. Links open outside through onLink.
 */
export function inline(text: string, onLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(\n)|(<https?:\/\/[^\s<>]+>|https?:\/\/[^\s<>`]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    let used = t.length;
    if (m[1]) out.push(<InlineCode key={k++} code={t.slice(1, -1)} />);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<del key={k++}>{t.slice(2, -2)}</del>);
    else if (m[4]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (m[6]) out.push(<br key={k++} />);
    else if (m[7]) {
      // "<https://…>" is the whole address; a bare one stops before the sentence's punctuation,
      // which is read again as text.
      const angled = t.startsWith("<");
      const url = angled ? t.slice(1, -1) : trimBareUrl(t);
      if (!angled) {
        used = url.length;
        re.lastIndex = m.index + used;
      }
      if (onLink && !/^https?:\/\/$/.test(url)) out.push(<Link key={k++} label={url} url={url} onLink={onLink} />);
      else out.push(t.slice(0, used));
    } else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      out.push(<Link key={k++} label={lm[1]!} url={lm[2]!} onLink={onLink} />);
    }
    last = m.index + used;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LINK = "font-medium text-leaf underline underline-offset-2";

function Link({ label, url, onLink }: { label: string; url: string; onLink?: ((url: string) => void) | undefined }) {
  const files = useContext(FileLinksContext);
  const menu = useContext(LinkMenuContext);
  const ref = !/^[a-z][\w+.-]*:/i.test(url) && files ? fileRef(decoded(url), files.root) : null;
  if (ref && files)
    return (
      <button type="button" onClick={() => files.open(ref)} onContextMenu={copyPathMenu(ref)} title={`Open ${ref.path}`} className={LINK}>
        {label}
      </button>
    );
  if (/^https?:\/\//i.test(url) && onLink) {
    // The whole address shows on hover, and the real site sits beside text that names another.
    const link = (
      <button type="button" onClick={() => onLink(url)} title={url} className={LINK}>
        {label}
      </button>
    );
    const host = mismatchedHost(label, url);
    return (
      <>
        {menu ? menu(url, link) : link}
        {host && <span className="text-ink-faint"> ({host})</span>}
      </>
    );
  }
  return <span className="underline underline-offset-2">{label}</span>;
}

/** Right-click copies the path (and line) instead of showing the page's menu. */
const copyPathMenu = (ref: FileRef) => (e: MouseEvent) => {
  e.preventDefault();
  void navigator.clipboard?.writeText(ref.line ? `${ref.path}:${ref.line}` : ref.path);
};

/** Double-clicking inline code selects all of it, not just one word. */
const selectAll = (e: MouseEvent<HTMLElement>) => {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(e.currentTarget);
  sel.removeAllRanges();
  sel.addRange(range);
};

/** Inline code; a project file's path in it opens the file (right-click copies the path). */
function InlineCode({ code }: { code: string }) {
  const files = useContext(FileLinksContext);
  const ref = files ? fileRef(code, files.root) : null;
  if (ref && files)
    return (
      <code
        dir="ltr"
        role="link"
        tabIndex={0}
        title={`Open ${ref.path}${ref.line ? ` at line ${ref.line}` : ""} in the side panel. Right-click copies the path.`}
        onClick={() => window.getSelection()?.isCollapsed !== false && files.open(ref)}
        onKeyDown={e => {
          if (e.key === "Enter") files.open(ref);
        }}
        onContextMenu={copyPathMenu(ref)}
        className="md-file"
      >
        {code}
      </code>
    );
  return (
    <code dir="ltr" onDoubleClick={selectAll}>
      {code}
    </code>
  );
}

export function Markdown({ text, onLink, className }: { text: string; onLink?: (url: string) => void; className?: string }) {
  return <div className={`md ${className ?? ""}`}>{renderBlocks(parseBlocks(text), onLink)}</div>;
}

/**
 * Markdown that may still be growing (an agent's reply as it streams). The text is cut at
 * blank lines between finished blocks and each piece is memoised, so only the last block
 * is parsed and drawn again as more arrives. Pass a stable `onLink`.
 */
export function StreamingMarkdown({ text, onLink, className }: { text: string; onLink?: (url: string) => void; className?: string }) {
  const pieces = splitMarkdownBlocks(text) ?? [text];
  return (
    <div className={`md ${className ?? ""}`}>
      {pieces.map((piece, i) => (
        <MarkdownPiece key={i} text={piece} onLink={onLink} />
      ))}
    </div>
  );
}

const MarkdownPiece = memo(function MarkdownPiece({ text, onLink }: { text: string; onLink?: ((url: string) => void) | undefined }) {
  return <>{renderBlocks(parseBlocks(text), onLink)}</>;
});

function renderBlocks(blocks: Block[], onLink?: (url: string) => void): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.kind) {
      case "heading": {
        const Tag = (["h2", "h3", "h4", "h4", "h4", "h4"] as const)[b.level - 1]!;
        return (
          <Tag key={i} dir="auto">
            {inline(b.text, onLink)}
          </Tag>
        );
      }
      case "para":
        return (
          <p key={i} dir="auto">
            {inline(b.text, onLink)}
          </p>
        );
      case "quote":
        return (
          <blockquote key={i} dir="auto">
            {renderBlocks(b.blocks, onLink)}
          </blockquote>
        );
      case "rule":
        return <hr key={i} />;
      case "code":
        return <CodeBlock key={i} code={b.text} lang={b.lang} />;
      case "list": {
        const items = b.items.map((it, j) => (
          <li key={j} dir="auto" className={it.task !== null ? "md-task" : undefined}>
            {it.task !== null && <input type="checkbox" checked={it.task} readOnly disabled aria-label={it.task ? "Done" : "Not done"} className="md-check" />}
            {renderItem(it.blocks, onLink)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start !== 1 ? b.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case "table":
        return <Table key={i} head={b.head} rows={b.rows} onLink={onLink} />;
      default:
        return <Fragment key={i} />;
    }
  });
}

/** A list item's blocks; a lone paragraph sits in the item as text, so tight lists stay tight. */
function renderItem(blocks: Block[], onLink?: (url: string) => void): ReactNode {
  const [first, ...rest] = blocks;
  if (first?.kind !== "para") return renderBlocks(blocks, onLink);
  return (
    <>
      {inline(first.text, onLink)}
      {rest.length > 0 && <div className="md-nested">{renderBlocks(rest, onLink)}</div>}
    </>
  );
}

/** A table as Markdown, for copying. */
export function tableMarkdown(head: string[], rows: string[][]): string {
  const row = (r: string[]) => `| ${r.map(c => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [row(head), `| ${head.map(() => "---").join(" | ")} |`, ...rows.map(row)].join("\n");
}

/** A table as CSV (quoted where needed), for pasting into a spreadsheet. Markdown marks are taken off. */
export function tableCsv(head: string[], rows: string[][]): string {
  const plain = (c: string) =>
    c.replace(/\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|~~([^~]+)~~|\[([^\]]+)\]\([^)]*\)/g, (_, ...g) => g.slice(0, 5).find(Boolean) ?? "");
  const cell = (c: string) => {
    const v = plain(c).replace(/\\\|/g, "|");
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [head, ...rows].map(r => r.map(cell).join(",")).join("\n");
}

function Table({ head, rows, onLink }: { head: string[]; rows: string[][]; onLink?: ((url: string) => void) | undefined }) {
  return (
    <div className="group/table relative">
      <div className="md-table">
        <table>
          <thead>
            <tr>
              {head.map((h, j) => (
                <th key={j} dir="auto">
                  {inline(h, onLink)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, n) => (
                  <td key={n} dir="auto">
                    {inline(c, onLink)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover/table:opacity-100 focus-within:opacity-100">
        <CopyButton text={tableMarkdown(head, rows)} label="Copy the table as Markdown" caption="Markdown" />
        <CopyButton text={tableCsv(head, rows)} label="Copy the table as CSV" caption="CSV" />
      </div>
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const highlighted = useHighlighted(code, lang);
  const [wrap, setWrap] = useState(false);
  // The buttons sit in a sticky strip as tall as themselves, so on a long block they stay in
  // view while the block scrolls past, and never hang below the block's end.
  return (
    <div className="group/code relative">
      <div className="pointer-events-none sticky top-1.5 z-[1] -mb-8 flex h-8 justify-end gap-1 pt-1.5 pr-1.5">
        <button
          type="button"
          aria-label="Wrap long lines"
          aria-pressed={wrap}
          title={wrap ? "Don't wrap long lines" : "Wrap long lines"}
          onClick={() => setWrap(w => !w)}
          className={`pointer-events-auto inline-flex h-7 items-center rounded-md border border-line bg-paper px-1.5 text-ink-soft opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-ink focus-visible:opacity-100 ${wrap ? "bg-cream-deep text-ink opacity-100" : ""}`}
        >
          <WrapText aria-hidden="true" className="size-3.5" />
        </button>
        <CopyButton
          text={code}
          label="Copy code"
          className="pointer-events-auto opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        />
      </div>
      <pre dir="ltr" className={`${highlighted ? "md-code" : ""} ${wrap ? "md-wrap" : ""}`}>
        <code>{highlighted ?? code}</code>
      </pre>
    </div>
  );
}

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({
  text,
  label = "Copy",
  className,
  showLabel = false,
  caption,
}: {
  text: string;
  label?: string;
  className?: string;
  showLabel?: boolean;
  /** A word shown next to the icon (instead of "Copy"). */
  caption?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={label}
      onClick={() => {
        // "Copied" only once it really was; a refused write leaves the button as it is.
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className={`inline-flex h-7 items-center gap-1 rounded-md border border-line bg-paper px-1.5 text-[13px] text-ink-soft hover:text-ink ${className ?? ""}`}
    >
      {copied ? <Check aria-hidden="true" className="size-3.5 text-leaf" /> : <Copy aria-hidden="true" className="size-3.5" />}
      {(showLabel || caption) && <span>{copied ? "Copied" : (caption ?? "Copy")}</span>}
    </button>
  );
}
