import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { z } from "zod";

/**
 * Reading public GitHub repositories without an account: one listing of a repository's
 * files (the git tree API) and the files themselves (raw file links). The catalogues of
 * skills and plugins are built on these.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  /** A branch, tag or commit; HEAD when not given. */
  ref?: string | null | undefined;
}

const seg = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export const treeUrl = (r: RepoRef) =>
  `https://api.github.com/repos/${seg(r.owner)}/${seg(r.repo)}/git/trees/${encodeURIComponent(r.ref || "HEAD")}?recursive=1`;
export const rawUrl = (r: RepoRef, path: string) => `https://raw.githubusercontent.com/${seg(r.owner)}/${seg(r.repo)}/${seg(r.ref || "HEAD")}/${seg(path)}`;
export const repoPage = (r: RepoRef, path?: string) =>
  `https://github.com/${seg(r.owner)}/${seg(r.repo)}${path ? `/tree/${seg(r.ref || "HEAD")}/${seg(path)}` : ""}`;

/** "owner/repo" from a GitHub https link (with or without .git), or null for anything else. */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  const m = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export const TreeResponse = z.object({
  tree: z.array(z.looseObject({ path: z.string(), type: z.string(), size: z.number().optional() })),
  truncated: z.boolean().optional(),
});
export interface RepoFile {
  path: string;
  size: number;
}
export interface RepoTree {
  files: RepoFile[];
  /** GitHub stops listing very large repositories part way. */
  truncated: boolean;
}

/** The files (not folders) a tree API response lists. Throws if it isn't one. */
export function parseTree(raw: unknown): RepoTree {
  const r = TreeResponse.parse(raw);
  return { files: r.tree.filter(e => e.type === "blob").map(e => ({ path: e.path, size: e.size ?? 0 })), truncated: r.truncated ?? false };
}

/** A failed request, said plainly (GitHub limits how often it can be asked without an account). */
export class FetchProblem extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const get = (url: string, signal?: AbortSignal) => {
  const init: RequestInit = signal ? { signal } : {};
  return isTauri() ? tauriFetch(url, init) : globalThis.fetch(url, init);
};

async function ok(url: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await get(url, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new FetchProblem("Couldn't reach GitHub. Check your connection.", 0);
  }
  if (res.ok) return res;
  if (res.status === 403 || res.status === 429)
    throw new FetchProblem("GitHub is asking us to slow down. It lets apps without an account look a limited number of times an hour.", res.status);
  if (res.status === 404) throw new FetchProblem("That isn't on GitHub any more.", 404);
  throw new FetchProblem(`GitHub answered with an error (${res.status}).`, res.status);
}

export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return (await ok(url, signal)).json();
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  return (await ok(url, signal)).text();
}

export async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  return new Uint8Array(await (await ok(url, signal)).arrayBuffer());
}

const trees = new Map<string, Promise<RepoTree>>();

/** A repository's files, asked once per session. */
export function fetchTree(r: RepoRef): Promise<RepoTree> {
  const url = treeUrl(r);
  let p = trees.get(url);
  if (!p) {
    p = fetchJson(url).then(parseTree);
    trees.set(url, p);
    // A failure is forgotten, so trying again asks again.
    p.catch(() => trees.delete(url));
  }
  return p;
}

/** Bytes as base64, in chunks so big files don't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Run `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
