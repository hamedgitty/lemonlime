import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewEvent, ThreadEvent } from "@lemonlime/protocol";
import type { GitWorkspace } from "./git.ts";

/** Biggest thread (its own commits) that can move; bigger ones should go through GitHub. */
export const MAX_TELEPORT_BUNDLE_BYTES = 200 * 1024 * 1024;

export interface TeleportExport {
  transferId: string;
  /** Bytes of the git bundle of the thread's own commits (0: no commits of its own yet). */
  bundleBytes: number;
  historyBytes: number;
  /** sha256 of the bundle and of the history, "bundleHash:historyHash". */
  checksum: string;
  baseCommit: string | null;
  headCommit: string | null;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The kinds of event worth carrying over: the conversation and what was done, not live state. */
const CARRIED = new Set(["user_message", "agent_message", "tool_call", "tool_result", "file_diff", "notice", "error"]);

/**
 * Pack a thread to move it: its own commits (from where it left the base branch) as a git
 * bundle, and its history. Files go to `<dir>/<transferId>/`.
 */
export async function exportThread(o: { git: GitWorkspace | null; baseBranch: string; events: readonly ThreadEvent[]; dir: string }): Promise<TeleportExport> {
  const transferId = randomUUID();
  const out = join(o.dir, transferId);
  mkdirSync(out, { recursive: true });
  let bundle = Buffer.alloc(0);
  let baseCommit: string | null = null;
  let headCommit: string | null = null;
  if (o.git && (await o.git.hasCommits())) {
    headCommit = (await o.git.git(["rev-parse", "HEAD"])).trim();
    const base = await o.git.resolveBase(o.baseBranch);
    baseCommit = (await o.git.git(["merge-base", "HEAD", base], { allowFail: true })).trim() || null;
    if (baseCommit && baseCommit !== headCommit) {
      const file = join(out, "bundle");
      await o.git.git(["bundle", "create", file, "HEAD", `^${baseCommit}`]);
      if (statSync(file).size > MAX_TELEPORT_BUNDLE_BYTES)
        throw new Error("This thread's commits are too big to move this way; push its branch to GitHub instead.");
      bundle = readFileSync(file);
    }
  }
  const history = Buffer.from(JSON.stringify(o.events.filter(e => CARRIED.has(e.type) && !(e.type === "agent_message" && e.partial))));
  writeFileSync(join(out, "history.json"), history);
  const checksum = `${sha(bundle)}:${sha(history)}`;
  writeFileSync(join(out, "meta.json"), JSON.stringify({ checksum, baseCommit, headCommit }));
  return { transferId, bundleBytes: bundle.length, historyBytes: history.length, checksum, baseCommit, headCommit };
}

export type ImportResult = { ok: true; already: boolean; events: NewEvent[]; headCommit: string | null } | { ok: false; status: number; error: string };

/**
 * Take in a moved thread. Refuses to touch a branch that already has work of its own, so
 * nothing here is ever overwritten; checks both files against the checksum; and does
 * nothing the second time for the same transfer.
 */
export async function importThread(o: {
  git: GitWorkspace | null;
  baseBranch: string;
  transferId: string;
  checksum: string;
  bundle: Buffer | null;
  history: Buffer;
  markerDir: string;
}): Promise<ImportResult> {
  if (!/^[0-9a-f-]{36}$/.test(o.transferId)) return { ok: false, status: 400, error: "bad transfer id" };
  const marker = join(o.markerDir, `${o.transferId}.done`);
  if (existsSync(marker)) return { ok: true, already: true, events: [], headCommit: null };
  const [bundleHash, historyHash] = o.checksum.split(":");
  if (sha(o.bundle ?? Buffer.alloc(0)) !== bundleHash || sha(o.history) !== historyHash)
    return { ok: false, status: 422, error: "The moved files don't match their checksum; try again." };
  let events: ThreadEvent[];
  try {
    events = JSON.parse(o.history.toString("utf8")) as ThreadEvent[];
  } catch {
    return { ok: false, status: 400, error: "The history couldn't be read." };
  }
  let headCommit: string | null = null;
  if (o.git && o.bundle?.length) {
    const dirty = (await o.git.git(["status", "--porcelain"], { allowFail: true })).trim();
    const base = await o.git.resolveBase(o.baseBranch);
    const own = (await o.git.git(["rev-list", "--count", `${base}..HEAD`], { allowFail: true })).trim();
    if (dirty || (own && own !== "0"))
      return { ok: false, status: 409, error: "This thread already has work of its own, so nothing was moved into it. Move into a new thread instead." };
    const file = join(o.markerDir, `${o.transferId}.bundle`);
    mkdirSync(o.markerDir, { recursive: true });
    writeFileSync(file, o.bundle);
    // Fails (non-zero exit) when this repository lacks the commit the bundle builds on.
    const verified = await o.git.git(["bundle", "verify", "-q", file]).then(
      () => true,
      () => false,
    );
    if (!verified)
      return {
        ok: false,
        status: 409,
        error: "This copy of the repository is missing the commit the thread started from. Push the base branch, then try again.",
      };
    await o.git.git(["fetch", "-q", file, "HEAD"]);
    await o.git.git(["reset", "-q", "--hard", "FETCH_HEAD"]);
    headCommit = (await o.git.git(["rev-parse", "HEAD"])).trim();
  }
  mkdirSync(o.markerDir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  const carried = events
    .filter(e => CARRIED.has(e.type))
    .map(e => {
      const { threadId: _t, seq: _s, at: _a, ...rest } = e as ThreadEvent & Record<string, unknown>;
      return rest as NewEvent;
    });
  return { ok: true, already: false, events: carried, headCommit };
}
