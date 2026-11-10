import { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, RotateCw } from "lucide-react";
import { runnerHttpBase } from "@lemonlime/client";
import type { Connection } from "../lib/useThreadSession.ts";
import {
  CSV_MAX_ROWS,
  fileKind,
  formatBytes,
  HIGHLIGHT_MAX_CHARS,
  languageFor,
  looksBinary,
  parseCsv,
  TEXT_SHOW_MAX_CHARS,
  type FileKind,
} from "../lib/filePreview.ts";
import { useHighlighted } from "../lib/markdownHighlight.tsx";
import { Tip } from "./primitives.tsx";
import { Spinner, cx } from "./ui.tsx";

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; kind: FileKind; size: number; text: string | null; url: string | null; type: string };

/**
 * One file from the thread's folder, read through the runner: code and text highlighted,
 * images, CSV as a table, PDFs, audio and video. Reloads when the agent changes it.
 */
export function FileView({
  connection,
  path,
  version,
  onMention,
  line,
}: {
  connection: Connection | null;
  path: string;
  /** Scroll to this line and mark it (from a `path:line` link). */
  line?: number | undefined;
  /** Changes whenever the agent changes this file. */
  version: number;
  /** Put `@path` into the message being written. */
  onMention: (path: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!connection) {
      setLoaded({ state: "error", message: "Files open once the thread is running." });
      return;
    }
    const ctl = new AbortController();
    let url: string | null = null;
    void (async () => {
      try {
        const res = await fetch(`${runnerHttpBase(connection.url)}/file?path=${encodeURIComponent(path)}`, {
          headers: { authorization: `Bearer ${await connection.token()}` },
          signal: ctl.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          const message =
            res.status === 404
              ? "This file isn't there any more."
              : res.status === 413
                ? "This file is too big to show here."
                : (body?.error ?? `The runner said ${res.status}.`);
          return setLoaded({ state: "error", message });
        }
        const type = res.headers.get("content-type") ?? "";
        const buf = new Uint8Array(await res.arrayBuffer());
        let kind = fileKind(path);
        if (kind === "text" && (looksBinary(buf) || type === "application/octet-stream")) kind = "binary";
        const text = kind === "text" || kind === "csv" ? new TextDecoder().decode(buf.subarray(0, TEXT_SHOW_MAX_CHARS * 2)) : null;
        // A PDF opens in a frame, so its type is ours to set: a frame would run whatever type the runner named.
        if (kind === "pdf") url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
        else if (kind === "image" || kind === "audio" || kind === "video") url = URL.createObjectURL(new Blob([buf], { type: type || undefined }));
        setLoaded({ state: "ready", kind, size: buf.length, text, url, type });
      } catch (err) {
        if (!ctl.signal.aborted) setLoaded({ state: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      ctl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [connection, path, version, reload]);

  return (
    <div role="tabpanel" aria-label={path} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-soft [direction:rtl] text-left" title={path}>
          <bdi>{path}</bdi>
        </span>
        {loaded.state === "ready" && <span className="shrink-0 text-[13px] text-ink-faint tabular-nums">{formatBytes(loaded.size)}</span>}
        <Tip label="Mention in the message">
          <button
            type="button"
            aria-label="Mention in the message"
            onClick={() => onMention(path)}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-soft hover:bg-cream-deep hover:text-ink"
          >
            <AtSign aria-hidden="true" className="size-3.5" />
          </button>
        </Tip>
        <Tip label="Reload">
          <button
            type="button"
            aria-label="Reload"
            onClick={() => setReload(r => r + 1)}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-soft hover:bg-cream-deep hover:text-ink"
          >
            <RotateCw aria-hidden="true" className="size-3.5" />
          </button>
        </Tip>
      </div>
      {loaded.state === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-ink-faint">
          <Spinner />
        </div>
      ) : loaded.state === "error" ? (
        <p className="m-2 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">{loaded.message}</p>
      ) : (
        <Body loaded={loaded} path={path} line={line} />
      )}
    </div>
  );
}

function Body({ loaded, path, line }: { loaded: Extract<Loaded, { state: "ready" }>; path: string; line?: number | undefined }) {
  const name = path.split("/").at(-1) ?? path;
  switch (loaded.kind) {
    case "image":
      return (
        <div className="scroll-thin flex min-h-0 flex-1 items-center justify-center overflow-auto bg-cream-deep/50 p-4">
          <img src={loaded.url!} alt={name} className="max-h-full max-w-full rounded-md object-contain outline outline-1 -outline-offset-1 outline-line" />
        </div>
      );
    case "pdf":
      return <iframe src={loaded.url!} title={name} className="min-h-0 w-full flex-1 border-0 bg-paper" />;
    case "audio":
      return (
        <div className="flex flex-1 items-start justify-center p-6">
          <audio controls src={loaded.url!} aria-label={name} className="w-full max-w-[420px]" />
        </div>
      );
    case "video":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-rind p-2">
          <video controls src={loaded.url!} aria-label={name} className="max-h-full max-w-full" />
        </div>
      );
    case "csv":
      return <CsvTable text={loaded.text ?? ""} />;
    case "text":
      return <CodeText text={loaded.text ?? ""} path={path} line={line} />;
    default:
      return (
        <p className="m-2 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
          This file isn't text, so it can't be shown here.
        </p>
      );
  }
}

/** Code lines are 13px at 1.6 line height, under 8px of padding. */
const CODE_LINE_PX = 13 * 1.6;
const CODE_TOP_PX = 8;

function CodeText({ text, path, line }: { text: string; path: string; line?: number | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const cut = text.length > TEXT_SHOW_MAX_CHARS;
  const shown = cut ? text.slice(0, TEXT_SHOW_MAX_CHARS) : text;
  const highlighted = useHighlighted(shown, shown.length <= HIGHLIGHT_MAX_CHARS ? languageFor(path) : "");
  const lines = useMemo(() => {
    let n = 1;
    for (let i = 0; i < shown.length; i++) if (shown.charCodeAt(i) === 10) n++;
    return Array.from({ length: shown.endsWith("\n") ? n - 1 : n }, (_, i) => i + 1).join("\n");
  }, [shown]);
  // A link to a line puts it a third of the way down, so what comes before shows too.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !line) return;
    el.scrollTop = Math.max(0, CODE_TOP_PX + (line - 1) * CODE_LINE_PX - el.clientHeight / 3);
  }, [line, shown]);
  return (
    <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-auto bg-paper">
      <div className="relative flex min-w-max font-mono text-[13px] leading-[1.6]">
        {line ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bg-lemon-soft"
            style={{ top: CODE_TOP_PX + (line - 1) * CODE_LINE_PX, height: CODE_LINE_PX }}
          />
        ) : null}
        <pre aria-hidden="true" className="sticky left-0 shrink-0 border-r border-line bg-cream px-2.5 py-2 text-right text-ink-faint tabular-nums select-none">
          {lines}
        </pre>
        <pre className={cx("relative flex-1 px-3 py-2 text-ink", highlighted && "md-code")}>
          <code>{highlighted ?? shown}</code>
        </pre>
      </div>
      {cut && <p className="border-t border-line px-3 py-2 text-[13px] text-ink-soft">Only the start of this file is shown.</p>}
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text), [text]);
  if (!rows.length)
    return <p className="m-2 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">This file is empty.</p>;
  const [head, ...body] = rows;
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-paper">
      <table className="min-w-full border-collapse text-[13px]">
        <thead className="sticky top-0 bg-cream-deep">
          <tr>
            {head!.map((c, i) => (
              <th key={i} scope="col" className="border-b border-line-strong px-2.5 py-1.5 text-left font-semibold whitespace-nowrap text-ink">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="even:bg-cream/60">
              {r.map((c, j) => (
                <td key={j} className="max-w-[320px] truncate border-b border-line px-2.5 py-1 align-top whitespace-nowrap text-ink tabular-nums" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="px-3 py-2 text-[13px] text-ink-soft">Showing the first {CSV_MAX_ROWS.toLocaleString()} rows.</p>}
    </div>
  );
}
