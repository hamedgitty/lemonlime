import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Careful, read-only access to other agents' history folders. Nothing here writes, files
 * are opened without following symbolic links, links inside a root are never followed out
 * of it, and every read is bounded however big a file grows.
 */

/** Longest line kept. Longer ones (agents' request logs, pasted blobs) are skipped whole. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Biggest single JSON file read (OpenCode's older storage). */
export const MAX_JSON_FILE_BYTES = 4 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/** A history root, resolved once, or null when it isn't a folder on this computer. */
export function resolveRoot(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
}

/** A folder's files and folders, leaving out symbolic links (and anything unreadable). */
export function entries(dir: string): Entry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => !d.isSymbolicLink() && (d.isDirectory() || d.isFile()))
      .map(d => ({ name: d.name, path: join(dir, d.name), dir: d.isDirectory() }));
  } catch {
    return [];
  }
}

/** Size and last change of a regular file that isn't a link; null otherwise. */
export function fileInfo(path: string): { size: number; mtimeMs: number } | null {
  try {
    const s = lstatSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

function openNoFollow(path: string): number {
  // O_NOFOLLOW doesn't exist on Windows; there, `entries` already left links out.
  return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
}

/**
 * The lines of a file between byte `start` and `end`, as strings. A range that starts
 * mid-file drops its first (partial) line; lines longer than `maxLine` are skipped
 * without ever being held in memory.
 */
export function* readLines(path: string, o: { start?: number; end?: number; maxLine?: number } = {}): Generator<string> {
  const maxLine = o.maxLine ?? MAX_LINE_BYTES;
  let fd: number;
  try {
    fd = openNoFollow(path);
  } catch {
    return;
  }
  try {
    if (!fstatSync(fd).isFile()) return;
    const size = fstatSync(fd).size;
    const end = Math.min(o.end ?? size, size);
    let pos = Math.max(0, o.start ?? 0);
    // Starting mid-file: back up one byte so a range that begins exactly on a line still
    // keeps that line, then drop everything up to the first newline.
    let skipping = pos > 0;
    if (pos > 0) pos -= 1;
    const buf = Buffer.alloc(CHUNK);
    let parts: Buffer[] = [];
    let held = 0;
    while (pos < end) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
      if (n <= 0) break;
      pos += n;
      let from = 0;
      for (;;) {
        const nl = buf.indexOf(10, from);
        if (nl === -1 || nl >= n) break;
        if (!skipping) {
          const piece = buf.subarray(from, nl);
          if (held + piece.length <= maxLine) {
            const line = held ? Buffer.concat([...parts, piece]).toString("utf8") : piece.toString("utf8");
            if (line.trim()) yield line;
          }
        }
        parts = [];
        held = 0;
        skipping = false;
        from = nl + 1;
      }
      if (!skipping && from < n) {
        const rest = n - from;
        if (held + rest > maxLine) {
          // Too long to keep: drop what we have and skip to the next newline.
          parts = [];
          held = 0;
          skipping = true;
        } else {
          parts.push(Buffer.from(buf.subarray(from, n)));
          held += rest;
        }
      }
    }
    // The last line, if the range ends at the end of the file without a newline.
    if (!skipping && held && end === size) {
      const line = Buffer.concat(parts).toString("utf8");
      if (line.trim()) yield line;
    }
  } finally {
    closeSync(fd);
  }
}

/** Parsed JSON Lines records from the given byte ranges; malformed lines are skipped. */
export function* readJsonLines(path: string, ranges: { start: number; end: number }[]): Generator<Record<string, unknown>> {
  for (const range of ranges) {
    for (const line of readLines(path, range)) {
      const value = parseJson(line);
      if (value && typeof value === "object" && !Array.isArray(value)) yield value as Record<string, unknown>;
    }
  }
}

/** One small JSON file, or null if it's missing, too big, a link or not JSON. */
export function readJsonFile(path: string, maxBytes = MAX_JSON_FILE_BYTES): Record<string, unknown> | null {
  const info = fileInfo(path);
  if (!info || info.size > maxBytes) return null;
  let fd: number;
  try {
    fd = openNoFollow(path);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(info.size);
    const n = readSync(fd, buf, 0, info.size, 0);
    const value = parseJson(buf.subarray(0, n).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Which parts of a file to read: all of it when it's small, else its start and its end
 * (`partial`), so a scan stays quick even with conversations hundreds of MB long.
 */
export function scanRanges(size: number, head = 4 * 1024 * 1024, tail = 2 * 1024 * 1024): { ranges: { start: number; end: number }[]; partial: boolean } {
  if (size <= head + tail) return { ranges: [{ start: 0, end: size }], partial: false };
  return {
    ranges: [
      { start: 0, end: head },
      { start: size - tail, end: size },
    ],
    partial: true,
  };
}

export const exists = (path: string): boolean => existsSync(path);

/** An ISO timestamp from a string or epoch milliseconds, or null if it isn't one. */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  const t = d.getTime();
  // Before 2000 or more than a day ahead: a broken clock or not a timestamp at all.
  if (!Number.isFinite(t) || t < 946_684_800_000 || t > Date.now() + 86_400_000) return null;
  return d.toISOString();
}

/** The local calendar date of an ISO time, "YYYY-MM-DD". */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One line of text for a title: whitespace collapsed, cut at `max` characters. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
