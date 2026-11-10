import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Putting files into a thread's working folder. The agent can write there, so any folder on
 * the way may have been swapped for a link to somewhere else, and whatever is copied in may
 * itself hold links. Nothing here follows a link out of the folder it started in.
 */

/** Whether `path` is `root` or somewhere under it. Both must already be real paths. */
function within(root: string, path: string): boolean {
  const back = relative(root, path);
  return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

function lookAt(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Where `root/rel` really is, or null when a link (or a file) on the way there leads out of
 * `root`. A link that stays inside `root` is followed, because repositories do keep such
 * links. Missing folders on the way are made, unless `make` is false, when a missing one
 * also gives null. The last part of `rel` is not looked at: the caller decides what to do
 * with whatever is there.
 */
export function placeInside(root: string, rel: string, make = true): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0 || parts.some(p => p === "." || p === "..")) return null;
  let at = realRoot;
  for (const part of parts.slice(0, -1)) {
    const next = join(at, part);
    const there = lookAt(next);
    if (!there) {
      if (!make) return null;
      mkdirSync(next);
      at = next;
    } else if (there.isDirectory()) at = next;
    else if (there.isSymbolicLink()) {
      const real = realFolder(next);
      if (!real || !within(realRoot, real)) return null;
      at = real;
    } else return null;
  }
  return join(at, parts.at(-1)!);
}

/** The real path of a link, when it leads to a folder. */
function realFolder(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Copy the folder `source` to `root/rel`, over whatever is there. Returns false, copying
 * nothing, when that place isn't really inside `root`.
 *
 * In the copy, a link is kept only when it points at something inside `source`; one that
 * points anywhere else is left out. A link standing where a file or folder is about to be
 * written is removed first, never written through.
 */
export function copyFolderInside(source: string, root: string, rel: string): boolean {
  let to = placeInside(root, rel);
  if (!to) return false;
  let from: string;
  try {
    from = realpathSync(source);
  } catch {
    return false;
  }
  const there = lookAt(to);
  if (there?.isSymbolicLink()) {
    const real = realFolder(to);
    if (!real || !within(realpathSync(root), real)) return false;
    to = real;
  } else if (there && !there.isDirectory()) return false;
  else if (!there) mkdirSync(to);
  copyTree(from, from, to);
  return true;
}

function copyTree(sourceRoot: string, from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    const kind = lstatSync(src);
    const there = lookAt(dest);
    if (kind.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(src);
      } catch {
        continue;
      }
      if (!within(sourceRoot, target)) continue;
      if (there) rmSync(dest, { recursive: true, force: true });
      try {
        symlinkSync(relative(dirname(src), target), dest);
      } catch {
        /* this system doesn't let us make links; the copy goes without it */
      }
    } else if (kind.isDirectory()) {
      if (there && !there.isDirectory()) rmSync(dest, { recursive: true, force: true });
      if (!there?.isDirectory()) mkdirSync(dest);
      copyTree(sourceRoot, src, dest);
    } else if (kind.isFile()) {
      // Whatever is there goes first, so the copy is a file of its own and not a way into another.
      if (there) rmSync(dest, { recursive: true, force: true });
      copyFileSync(src, dest);
    }
  }
}
