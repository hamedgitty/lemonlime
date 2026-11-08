/**
 * How a file tab shows a file from the thread's folder: highlighted code or text, an image,
 * a CSV as a table, a PDF, audio or video, or a note that it can't be shown.
 */

export type FileKind = "text" | "image" | "csv" | "pdf" | "audio" | "video" | "binary";

const BY_EXT: Record<string, FileKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  csv: "csv",
  tsv: "csv",
  pdf: "pdf",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  mp4: "video",
  webm: "video",
  mov: "video",
  zip: "binary",
  gz: "binary",
  tgz: "binary",
  jar: "binary",
  wasm: "binary",
  exe: "binary",
  dll: "binary",
  so: "binary",
  dylib: "binary",
  o: "binary",
  a: "binary",
  class: "binary",
  woff: "binary",
  woff2: "binary",
  ttf: "binary",
  otf: "binary",
  sqlite: "binary",
  db: "binary",
};

export const extOf = (path: string): string => {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** What kind of file this is, from its name; unknown ones are text unless their bytes say otherwise. */
export function fileKind(path: string): FileKind {
  return BY_EXT[extOf(path)] ?? "text";
}

/** NUL bytes near the start mean it isn't text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

const NAMED: Record<string, string> = {
  dockerfile: "docker",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".gitignore": "ini",
  ".env": "ini",
  ".env.example": "ini",
};

const EXT_LANG: Record<string, string> = {
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  vue: "markup",
  svelte: "markup",
  lock: "yaml",
  conf: "ini",
  cfg: "ini",
  properties: "ini",
  gradle: "kotlin",
  kts: "kotlin",
  mdx: "markdown",
  htm: "markup",
};

/** The language tag to highlight with (the highlighter knows the common aliases), or "" for plain text. */
export function languageFor(path: string): string {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  if (NAMED[name]) return NAMED[name];
  const ext = extOf(path);
  return EXT_LANG[ext] ?? ext;
}

/** Above this, text shows plain (highlighting a huge file would stall the app). */
export const HIGHLIGHT_MAX_CHARS = 200_000;
/** Above this, only the start of a text file shows. */
export const TEXT_SHOW_MAX_CHARS = 2_000_000;
/** Rows shown from a CSV file. */
export const CSV_MAX_ROWS = 1000;

/**
 * A CSV (or TSV) file as rows of cells: quoted cells may hold commas, quotes ("") and line
 * breaks. Stops after `maxRows`, saying whether there was more.
 */
export function parseCsv(text: string, opts: { delimiter?: string; maxRows?: number } = {}): { rows: string[][]; truncated: boolean } {
  const d = opts.delimiter ?? (text.slice(0, 2000).split("\t").length > text.slice(0, 2000).split(",").length ? "\t" : ",");
  const max = opts.maxRows ?? CSV_MAX_ROWS;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= max) return { rows, truncated: i < text.length - 1 };
    } else cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, truncated: false };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
