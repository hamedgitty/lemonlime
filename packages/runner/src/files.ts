import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Reading one file from the thread's working folder for the app's file tabs (`GET /file`).
 * The path the app sends is relative to the working folder and must stay inside it, after
 * symlinks are followed too. The repository's `.git` folder and the runner's own
 * `.lemonlime` folder are off limits: they can hold credentials and the thread's history.
 */

export type FileRead = { path: string; data: Buffer } | { error: string; status: number };

/** Longest path the app may ask for. */
const MAX_PATH_CHARS = 4096;

/** The path's parts, or null when it isn't a plain relative path. */
export function relativeParts(asked: string): string[] | null {
  if (!asked || asked.length > MAX_PATH_CHARS || asked.includes("\0")) return null;
  // Absolute in any form: /etc, \\server\share, C:\ or C:/.
  if (asked.startsWith("/") || asked.startsWith("\\") || /^[A-Za-z]:/.test(asked) || isAbsolute(asked)) return null;
  const parts = asked.split(/[\\/]+/).filter(p => p && p !== ".");
  if (!parts.length || parts.some(p => p === "..")) return null;
  return parts;
}

/** Folders a file tab may never read from. */
function offLimits(parts: readonly string[]): boolean {
  return parts[0] === ".lemonlime" || parts.some(p => p === ".git");
}

export async function resolveWorkdirFile(workdir: string, asked: string, maxBytes: number): Promise<FileRead> {
  const parts = relativeParts(asked);
  if (!parts) return { error: "Give a path inside the thread's folder.", status: 400 };
  if (offLimits(parts)) return { error: "That folder can't be opened here.", status: 403 };
  let root: string;
  let real: string;
  try {
    root = await realpath(workdir);
    real = await realpath(join(root, ...parts));
  } catch {
    return { error: "No such file.", status: 404 };
  }
  // Symlinks are followed: what they point at must be inside too.
  const inside = relative(root, real);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    return { error: "That file is outside the thread's folder.", status: 403 };
  if (offLimits(inside.split(sep))) return { error: "That folder can't be opened here.", status: 403 };
  const handle = await open(real, "r").catch(() => null);
  if (!handle) return { error: "No such file.", status: 404 };
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: "That's not a file.", status: 400 };
    if (info.size > maxBytes) return { error: "That file is too big to show here.", status: 413 };
    const data = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) {
      const { bytesRead } = await handle.read(data, read, info.size - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { path: real, data: data.subarray(0, read) };
  } finally {
    await handle.close();
  }
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json",
};

/** A content type from the file's extension, or by looking at it: text unless it has NUL bytes. */
export function contentTypeFor(path: string, data?: Buffer): string {
  const known = TYPES[extname(path).toLowerCase()];
  if (known) return known;
  if (data && data.subarray(0, 8000).includes(0)) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}
