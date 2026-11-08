import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

/** Uploads arrive in pieces of at most this size, so a dropped connection costs one piece. */
export const ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Folder in the thread's working copy that agents read attachments from (kept out of git). */
export const ATTACHMENTS_DIR = ".lemonlime-attachments";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

export function isImage(name: string): boolean {
  return IMAGE.test(name);
}

/** Image types apps can show, by extension (HEIC and BMP aren't served: browsers can't show them all). */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A safe file name: no folders, no leading dots, nothing odd. */
export function cleanName(name: string): string {
  const base = basename(name.replace(/\\/g, "/"))
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return base || "file";
}

export interface Upload {
  id: string;
  name: string;
  size: number;
  received: number;
  done: boolean;
  /** Path relative to the working folder, once done. */
  path?: string;
}

/**
 * Resumable uploads into the thread's working folder: the client sends a file in pieces
 * at increasing offsets; a piece at the wrong offset is refused with where to continue.
 * Finished files sit in `.lemonlime-attachments/<id>/<name>` for the agent to read.
 */
export class Attachments {
  private uploads = new Map<string, Upload>();

  constructor(private readonly workdir: string) {}

  get(id: string): Upload | null {
    return this.uploads.get(id) ?? null;
  }

  /** Start (or look up) an upload. Size limits are checked here, before any bytes move. */
  begin(id: string, name: string, size: number): Upload | { error: string; status: number } {
    if (!UPLOAD_ID.test(id)) return { error: "bad upload id", status: 400 };
    const existing = this.uploads.get(id);
    if (existing) return existing;
    const clean = cleanName(name);
    const limit = isImage(clean) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!Number.isInteger(size) || size <= 0) return { error: "empty file", status: 400 };
    if (size > limit) return { error: `${isImage(clean) ? "Images" : "Files"} can be up to ${limit / 1024 / 1024} MB.`, status: 413 };
    const upload: Upload = { id, name: clean, size, received: 0, done: false };
    this.uploads.set(id, upload);
    return upload;
  }

  /** Add the piece at `offset`. */
  write(id: string, offset: number, data: Buffer): Upload | { error: string; status: number; received?: number } {
    const u = this.uploads.get(id);
    if (!u) return { error: "unknown upload", status: 404 };
    if (u.done) return u;
    if (offset !== u.received) return { error: "wrong offset", status: 409, received: u.received };
    if (data.length > ATTACHMENT_CHUNK_BYTES) return { error: "piece too large", status: 413 };
    if (u.received + data.length > u.size) return { error: "more bytes than the file has", status: 400 };
    const dir = join(this.workdir, ATTACHMENTS_DIR, id);
    mkdirSync(dir, { recursive: true });
    const partial = join(dir, `${u.name}.part`);
    if (offset === 0) writeFileSync(partial, data);
    else appendFileSync(partial, data);
    u.received += data.length;
    if (u.received === u.size) {
      const final = join(dir, u.name);
      renameSync(partial, final);
      u.done = true;
      u.path = join(ATTACHMENTS_DIR, id, u.name);
    }
    return u;
  }

  /**
   * A sent image, to show it back in the thread: the one finished file in
   * `.lemonlime-attachments/<id>/`, read from disk so it still works after a restart. Only
   * plain image files inside that folder qualify: no links, nothing half uploaded, nothing
   * bigger than an image upload may be.
   */
  image(id: string): { path: string; name: string; type: string; size: number } | { error: string; status: number } {
    if (!UPLOAD_ID.test(id)) return { error: "bad upload id", status: 400 };
    const notFound = { error: "not found", status: 404 };
    try {
      const root = realpathSync(join(this.workdir, ATTACHMENTS_DIR));
      const dir = join(root, id);
      if (!lstatSync(dir).isDirectory()) return notFound;
      const names = readdirSync(dir).filter(n => !n.endsWith(".part"));
      if (names.length !== 1) return notFound;
      const name = names[0]!;
      const type = IMAGE_TYPES[extname(name).toLowerCase()];
      if (!type) return { error: "not an image", status: 415 };
      const path = join(dir, name);
      const info = lstatSync(path);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return notFound;
      if (!realpathSync(path).startsWith(root + sep)) return notFound;
      return { path, name, type, size: info.size };
    } catch {
      return notFound;
    }
  }

  /** Finished uploads by id, or the ids that aren't finished. */
  resolve(ids: string[]): { ok: Upload[] } | { missing: string[] } {
    const missing = ids.filter(id => !this.uploads.get(id)?.done || !existsSync(join(this.workdir, this.uploads.get(id)!.path!)));
    if (missing.length) return { missing };
    return { ok: ids.map(id => this.uploads.get(id)!) };
  }
}

/** What the agent is told about the files that came with a message. */
export function attachmentNote(files: Upload[]): string {
  const lines = files.map(f => `- ${f.path} (${isImage(f.name) ? "image" : extname(f.name).slice(1) || "file"}, ${formatSize(f.size)})`);
  return `The user attached ${files.length === 1 ? "a file" : `${files.length} files`}, saved in the working folder; read ${files.length === 1 ? "it" : "them"} as needed:\n${lines.join("\n")}`;
}

function formatSize(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const sizeOnDisk = (path: string) => (existsSync(path) ? statSync(path).size : 0);
