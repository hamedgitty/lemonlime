import { invoke, isTauri } from "@tauri-apps/api/core";
import { HistoryImportResult, HistoryScan } from "@lemonlime/protocol";
import { LocalThreadMeta, loadLocalThreads, saveLocalThreads } from "./storage.ts";

/**
 * Conversations the user already had with Claude Code, Codex or OpenCode on this computer,
 * outside LemonLime: what the setup wizard's "Import your work" step and the Automations
 * "Scans" tab show. Wraps the Rust commands in src-tauri/src/history.rs, which run
 * `lemonlime-runner history scan|import`. The agents' own files are only ever read.
 *
 * Typical use:
 *
 *   const scan = await scanAgentHistory(30, { runnerPath: settings.runnerPath });
 *   // show scan.agents["claude-code"].perDay, .folders, and scan.sessions to pick from
 *   const result = await importAgentSessions(pickedIds, { runnerPath: settings.runnerPath });
 *   setLocalThreads(list => mergeImportedThreads(list, result));
 *   // result.skipped says, per conversation, why it wasn't imported
 *
 * An imported thread opens like any local thread: its runner starts in a new worktree of
 * `repoPath` on `branch`, shows the imported history, and gives the agent a recap of it
 * with the first new message.
 */

export type { AgentHistoryScan, HistoryAgent, HistoryFolder, HistoryScan, HistorySession } from "@lemonlime/protocol";
export { HISTORY_AGENT_NAMES } from "@lemonlime/protocol";

/** Furthest back a scan can look, in days. */
export const MAX_SCAN_DAYS = 3650;

export interface ScanAgentHistoryOptions {
  /** Most conversations listed in `sessions` (default 200, newest first). Counts always cover all. */
  limit?: number;
  /** The lemonlime-runner setting (Settings.runnerPath); empty looks it up as usual. */
  runnerPath?: string;
}

/**
 * Summarise the conversations saved on this computer, per agent: whether its history was
 * found, how many conversations there are (`sessions`) and how many were updated in the
 * last `sinceDays` (`inRange`), activity per local day for the last 365 days (`perDay`),
 * and the folders used in range. `sessions` lists the in-range conversations to import;
 * one already imported has `importedThreadId`.
 *
 * Quick even with very large histories: big files are read only at their start and end
 * (those sessions have `partial: true`, and their `messageCount` is a lower bound).
 * Outside the desktop app this resolves to an empty scan.
 */
export async function scanAgentHistory(sinceDays = 30, opts: ScanAgentHistoryOptions = {}): Promise<HistoryScan> {
  const days = Math.min(MAX_SCAN_DAYS, Math.max(1, Math.round(sinceDays)));
  if (!isTauri()) return emptyScan(days);
  const raw = await invoke<unknown>("scan_agent_history", {
    sinceDays: days,
    limit: opts.limit ?? null,
    runnerPath: opts.runnerPath || null,
  });
  return HistoryScan.parse(raw);
}

/** One conversation that is now a local thread. */
export interface ImportedSession {
  /** The id that was asked for (`<agent>:<session id>`). */
  id: string;
  /** The thread, ready to keep with the other local threads. */
  thread: LocalThreadMeta;
  /** It had been imported before: this is that thread, nothing new was made. */
  already: boolean;
}

/** A conversation that wasn't imported, and why, in words to show the user. */
export interface SkippedSession {
  id: string;
  reason: string;
}

export interface ImportAgentSessionsResult {
  imported: ImportedSession[];
  skipped: SkippedSession[];
}

/**
 * Make local threads from conversations a scan listed (`HistorySession.id`). Each gets a
 * new thread whose repository is the git repository the conversation ran in, based on that
 * repository's current branch. Conversations that didn't run in a git repository (or
 * whose folder is gone) are skipped with a reason. Safe to repeat: a conversation imported
 * before comes back as the same thread with `already: true`.
 *
 * The returned threads aren't saved anywhere yet: add them to the app's list of local
 * threads with `mergeImportedThreads` (or `importAgentSessionsIntoStorage`).
 */
export async function importAgentSessions(ids: readonly string[], opts: { runnerPath?: string } = {}): Promise<ImportAgentSessionsResult> {
  const unique = [...new Set(ids)];
  if (!unique.length) return { imported: [], skipped: [] };
  if (!isTauri()) throw new Error("Importing conversations needs the LemonLime desktop app.");
  const raw = await invoke<unknown>("import_agent_sessions", { ids: unique, runnerPath: opts.runnerPath || null });
  const result = HistoryImportResult.parse(raw);
  return {
    imported: result.imported.map(i => ({ id: i.id, thread: LocalThreadMeta.parse(i.thread), already: i.already })),
    skipped: result.skipped,
  };
}

/**
 * The local thread list with the imported threads added: new ones first (newest
 * conversation first), and none twice, so it is safe to call with a repeated import. A
 * thread already in the list is left as it is (the app may have newer state for it).
 */
export function mergeImportedThreads(existing: readonly LocalThreadMeta[], result: Pick<ImportAgentSessionsResult, "imported">): LocalThreadMeta[] {
  const have = new Set(existing.map(t => t.id));
  const added: LocalThreadMeta[] = [];
  for (const { thread } of result.imported) {
    if (have.has(thread.id)) continue;
    have.add(thread.id);
    added.push(thread);
  }
  added.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...added, ...existing];
}

/**
 * Import and save straight into local storage, for callers outside the app's own thread
 * state (e.g. a setup step before the main window loads its list). Inside the running app,
 * prefer `importAgentSessions` + `mergeImportedThreads` with its state setter, which also
 * saves, so the two never overwrite each other.
 */
export async function importAgentSessionsIntoStorage(
  ids: readonly string[],
  opts: { runnerPath?: string } = {},
): Promise<ImportAgentSessionsResult & { threads: LocalThreadMeta[] }> {
  const result = await importAgentSessions(ids, opts);
  const threads = mergeImportedThreads(loadLocalThreads(), result);
  saveLocalThreads(threads);
  return { ...result, threads };
}

/**
 * What the runner has kept of one of LemonLime's own threads on this computer: its history
 * file as text, one event per line (`parseHistory` in exportChats.ts reads it). Null when it
 * has kept nothing for that thread here, and outside the desktop app. The thread's runner
 * doesn't have to be running.
 */
export async function readThreadHistory(threadId: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("read_thread_history", { threadId });
}

function emptyScan(sinceDays: number): HistoryScan {
  const none = { found: false, sessions: 0, inRange: 0, perDay: {}, folders: [], note: "Scanning needs the LemonLime desktop app." };
  return { scannedAt: new Date().toISOString(), sinceDays, agents: { "claude-code": none, codex: { ...none }, opencode: { ...none } }, sessions: [] };
}
