import { Fragment, type ReactNode } from "react";

/**
 * A small Markdown renderer for skill and plugin docs: headings, paragraphs, lists,
 * quotes, fenced code, tables, rules, and inline code, bold, italics and links.
 * It builds React elements, never HTML strings, so nothing in the text can run.
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

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map(c => c.trim());

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^(\s*)(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const close = fence[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!);
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
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) items.push(m[2]!);
        else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|~~~|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    out.push({ kind: "para", text: para.join(" ") });
  }
  return out;
}

/** Inline: `code`, **bold**, *italic*, [text](https://…). Links open outside through onLink. */
export function inline(text: string, onLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      const url = lm[2]!;
      out.push(
        /^https?:\/\//i.test(url) && onLink ? (
          <button key={k++} type="button" onClick={() => onLink(url)} className="font-medium text-leaf underline underline-offset-2">
            {lm[1]}
          </button>
        ) : (
          <span key={k++} className="underline underline-offset-2">
            {lm[1]}
          </span>
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onLink, className }: { text: string; onLink?: (url: string) => void; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`md ${className ?? ""}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const Tag = (["h2", "h3", "h4", "h4", "h4", "h4"] as const)[b.level - 1]!;
            return <Tag key={i}>{inline(b.text, onLink)}</Tag>;
          }
          case "para":
            return <p key={i}>{inline(b.text, onLink)}</p>;
          case "quote":
            return <blockquote key={i}>{inline(b.text, onLink)}</blockquote>;
          case "rule":
            return <hr key={i} />;
          case "code":
            return <CodeBlock key={i} code={b.text} />;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, onLink)}</li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j}>{inline(h, onLink)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, n) => (
                          <td key={n}>{inline(c, onLink)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <Fragment key={i} />;
        }
      })}
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="group/code relative">
      <pre>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(code)}
        className="absolute top-1.5 right-1.5 rounded-md border border-line bg-paper px-2 py-0.5 text-[12px] text-ink-soft opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-ink focus-visible:opacity-100"
      >
        Copy
      </button>
    </div>
  );
}
