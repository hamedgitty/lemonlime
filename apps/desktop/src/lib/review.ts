import { runnerHttpBase } from "@lemonlime/client";
import { GitDiffResponse, GitPullRequestResponse, GitStatusResponse, type CreatePullRequestBody, type DiffHunk, type DiffScope } from "@lemonlime/protocol";
import type { Connection } from "./useThreadSession.ts";

/** The runner's git review API (see docs/runner.md, "Reviewing the branch"). */

export class ReviewUnavailable extends Error {}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function call<T>(
  connection: Connection,
  path: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const res = await fetchImpl(`${runnerHttpBase(connection.url)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await connection.token()}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  const body = (await res.json().catch(() => null)) as unknown;
  // An older runner without the API, or a thread without git: the app falls back to the agent's own diffs.
  if (res.status === 404) throw new ReviewUnavailable("This runner can't show git diffs.");
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `The runner answered with HTTP ${res.status}.`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error("The runner sent an answer this app doesn't understand.");
  return parsed.data;
}

export interface DiffRequest {
  scope: DiffScope;
  commit?: string;
  path?: string;
  oldPath?: string;
  context?: number;
}

export function fetchGitDiff(connection: Connection, q: DiffRequest, fetchImpl?: FetchLike): Promise<GitDiffResponse> {
  const params = new URLSearchParams({ scope: q.scope });
  if (q.commit) params.set("commit", q.commit);
  if (q.path) params.set("path", q.path);
  if (q.oldPath) params.set("oldPath", q.oldPath);
  if (q.context !== undefined) params.set("context", String(q.context));
  return call(connection, `/git/diff?${params}`, GitDiffResponse, {}, fetchImpl);
}

export function fetchGitStatus(connection: Connection, fetchImpl?: FetchLike): Promise<GitStatusResponse> {
  return call(connection, "/git/status", GitStatusResponse, {}, fetchImpl);
}

export function fetchPullRequest(connection: Connection, fetchImpl?: FetchLike): Promise<GitPullRequestResponse> {
  return call(connection, "/git/pull-request", GitPullRequestResponse, {}, fetchImpl);
}

const Ok = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };

export async function pushBranch(connection: Connection, fetchImpl?: FetchLike): Promise<void> {
  await call(connection, "/git/push", Ok, { method: "POST" }, fetchImpl);
}

export function createPullRequest(connection: Connection, body: CreatePullRequestBody, fetchImpl?: FetchLike): Promise<GitPullRequestResponse> {
  return call(connection, "/git/pull-request", GitPullRequestResponse, { method: "POST", body: JSON.stringify(body) }, fetchImpl);
}

// ── Showing hunks ──────────────────────────────────────────────

export interface ReviewLine {
  kind: "add" | "del" | "context" | "note";
  /** The line without its +/-/space marker. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** A hunk's lines with their old and new line numbers. */
export function numberHunk(h: DiffHunk): ReviewLine[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map(raw => {
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") return { kind: "add", text, oldNo: null, newNo: n++ };
    if (mark === "-") return { kind: "del", text, oldNo: o++, newNo: null };
    if (mark === "\\") return { kind: "note", text: raw, oldNo: null, newNo: null };
    return { kind: "context", text, oldNo: o++, newNo: n++ };
  });
}

export interface SplitRow {
  left: ReviewLine | null;
  right: ReviewLine | null;
}

/** Side-by-side rows: context on both sides, a run of removals paired with the additions after it. */
export function splitRows(lines: ReviewLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!;
    if (l.kind === "context" || l.kind === "note") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: ReviewLine[] = [];
    const adds: ReviewLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/** Lines hidden between two hunks (or before the first), in the new file. */
export function hiddenBefore(hunks: DiffHunk[], index: number): number {
  const h = hunks[index];
  if (!h) return 0;
  const prev = hunks[index - 1];
  const start = prev ? prev.newStart + prev.newLines : 1;
  return Math.max(0, h.newStart - start);
}

/**
 * The text "Add to chat" puts in the composer: where the lines are (file:line or
 * file:first-last, new-file numbers when there are any) and the lines as a quoted diff.
 */
export function quoteLines(path: string, lines: ReviewLine[]): string {
  const picked = lines.filter(l => l.kind !== "note");
  if (!picked.length) return "";
  const nums = picked.map(l => l.newNo ?? l.oldNo).filter((n): n is number => n !== null);
  const first = Math.min(...nums);
  const last = Math.max(...nums);
  const where = `${path}:${first === last ? first : `${first}-${last}`}`;
  const body = picked.map(l => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`).join("\n");
  const fence = body.includes("```") ? "````" : "```";
  return `${where}\n${fence}diff\n${body}\n${fence}\n`;
}

/** A path split so the file name stays whole and the folders can shrink. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
