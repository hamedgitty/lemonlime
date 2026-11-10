import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  branchForThread,
  HISTORY_AGENT_NAMES,
  HistoryAgent,
  newThreadId,
  type AgentHistoryScan,
  type HistoryImportResult,
  type HistoryScan,
  type HistorySession,
  type ImportedThreadMeta,
} from "@lemonlime/protocol";
import { EventStore } from "../event-store.ts";
import { runGit } from "../git.ts";
import { recapBefore } from "../thread-runner.ts";
import { listClaudeSessions, readClaudeSession } from "./claude-code.ts";
import { listCodexSessions, readCodexSession } from "./codex.ts";
import { listOpenCodeSessions, readOpenCodeSession } from "./opencode.ts";
import { localDate, parseJson } from "./read.ts";
import type { AgentListing, SessionInfo, Transcript } from "./types.ts";

export { cleanUserText } from "./claude-code.ts";
export { isInjected } from "./codex.ts";
export { readLines } from "./read.ts";

const DAY_MS = 86_400_000;
/** `perDay` covers this many days back. */
export const PER_DAY_WINDOW = 365;
/** Most imported events kept per thread (the newest); older ones are left out with a note. */
export const MAX_IMPORT_EVENTS = 2000;
/** Most conversations imported in one go. */
export const MAX_IMPORT_IDS = 500;

/** Where each agent keeps its history. */
export interface HistoryRoots {
  "claude-code": string;
  codex: string;
  opencode: string;
}

/** The agents' own defaults, honouring the variables each one reads. */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): HistoryRoots {
  return {
    "claude-code": resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude")),
    codex: resolve(env.CODEX_HOME || join(home, ".codex")),
    opencode: join(resolve(env.XDG_DATA_HOME || join(home, ".local", "share")), "opencode"),
  };
}

/** Folders LemonLime itself runs agents in; conversations there are already threads. */
const ownFolder = (lemonlimeHome: string) => {
  const worktrees = join(resolve(lemonlimeHome), "worktrees") + sep;
  return (cwd: string | null) => cwd !== null && (resolve(cwd) + sep).startsWith(worktrees);
};

// --- what has been imported -------------------------------------------------------------

interface ImportRecord {
  threadId: string;
  importedAt: string;
  thread: ImportedThreadMeta;
}
interface ImportMap {
  version: 1;
  sessions: Record<string, ImportRecord>;
}

const importsFile = (lemonlimeHome: string) => join(lemonlimeHome, "imports.json");
const threadDir = (lemonlimeHome: string, threadId: string) => join(lemonlimeHome, "threads", threadId);

function loadImports(lemonlimeHome: string): ImportMap {
  try {
    const raw = parseJson(readFileSync(importsFile(lemonlimeHome), "utf8")) as ImportMap | null;
    if (raw && raw.version === 1 && raw.sessions && typeof raw.sessions === "object") return raw;
  } catch {
    /* none yet */
  }
  return { version: 1, sessions: {} };
}

function saveImports(lemonlimeHome: string, map: ImportMap): void {
  mkdirSync(lemonlimeHome, { recursive: true });
  const file = importsFile(lemonlimeHome);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, file);
}

/** The thread a conversation became, while that thread's history still exists. */
function importedThread(lemonlimeHome: string, map: ImportMap, id: string): ImportRecord | null {
  const r = map.sessions[id];
  return r && existsSync(join(threadDir(lemonlimeHome, r.threadId), "events.jsonl")) ? r : null;
}

// --- scan -------------------------------------------------------------------------------

export interface ScanOptions {
  sinceDays: number;
  /** Most conversations listed (default 200). Counts always cover them all. */
  limit?: number;
  roots?: HistoryRoots;
  /** LemonLime's own folder (LEMONLIME_HOME), for what was imported already. */
  lemonlimeHome: string;
  now?: number;
}

async function listAll(roots: HistoryRoots, sinceMs: number): Promise<Record<HistoryAgent, AgentListing>> {
  const safely = async (agent: HistoryAgent, list: () => AgentListing | Promise<AgentListing>): Promise<AgentListing> => {
    try {
      return await list();
    } catch {
      return { found: true, note: `${HISTORY_AGENT_NAMES[agent]}'s history couldn't be read.`, total: 0, sessions: [] };
    }
  };
  const [claude, codex, opencode] = await Promise.all([
    safely("claude-code", () => listClaudeSessions(roots["claude-code"], sinceMs)),
    safely("codex", () => listCodexSessions(roots.codex, sinceMs)),
    safely("opencode", () => listOpenCodeSessions(roots.opencode, sinceMs)),
  ]);
  return { "claude-code": claude, codex, opencode };
}

/** Summarise every agent's saved conversations: counts, activity per day, folders, recent ones. */
export async function scanHistory(o: ScanOptions): Promise<HistoryScan> {
  const now = o.now ?? Date.now();
  const sinceDays = Math.max(1, Math.floor(o.sinceDays));
  const rangeStart = now - sinceDays * DAY_MS;
  const dayStart = now - PER_DAY_WINDOW * DAY_MS;
  const roots = o.roots ?? defaultRoots();
  const isOwn = ownFolder(o.lemonlimeHome);
  const imports = loadImports(o.lemonlimeHome);
  const listings = await listAll(roots, Math.min(rangeStart, dayStart));

  const firstDay = localDate(new Date(dayStart).toISOString());
  const agents = {} as HistoryScan["agents"];
  const recent: HistorySession[] = [];
  for (const agent of HistoryAgent.options) {
    const l = listings[agent];
    // LemonLime's own threads (run in its worktrees) and conversations with nothing in
    // them aren't counted.
    const mine = l.sessions.filter(s => !isOwn(s.cwd) && s.messageCount > 0);
    const perDay: Record<string, number> = {};
    for (const s of mine) for (const d of s.days) if (d >= firstDay) perDay[d] = (perDay[d] ?? 0) + 1;
    const inRange = mine.filter(s => Date.parse(s.updatedAt) >= rangeStart);
    const folders = new Map<string, { sessions: number; lastUsed: string }>();
    for (const s of inRange) {
      if (!s.cwd) continue;
      const f = folders.get(s.cwd) ?? { sessions: 0, lastUsed: s.updatedAt };
      f.sessions++;
      if (s.updatedAt > f.lastUsed) f.lastUsed = s.updatedAt;
      folders.set(s.cwd, f);
    }
    const scan: AgentHistoryScan = {
      found: l.found,
      sessions: Math.max(0, l.total - (l.sessions.length - mine.length)),
      inRange: inRange.length,
      perDay: Object.fromEntries(Object.entries(perDay).sort(([a], [b]) => a.localeCompare(b))),
      folders: [...folders].map(([path, f]) => ({ path, ...f })).sort((a, b) => b.lastUsed.localeCompare(a.lastUsed)),
      ...(l.note ? { note: l.note } : {}),
    };
    agents[agent] = scan;
    for (const s of inRange) {
      const id = `${agent}:${s.sessionId}`;
      const done = importedThread(o.lemonlimeHome, imports, id);
      recent.push({
        id,
        agent,
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        partial: s.partial,
        ...(done ? { importedThreadId: done.threadId } : {}),
      });
    }
  }
  recent.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { scannedAt: new Date(now).toISOString(), sinceDays, agents, sessions: recent.slice(0, Math.max(0, o.limit ?? 200)) };
}

// --- import -----------------------------------------------------------------------------

export interface ImportOptions {
  /** Ids from a scan: `<agent>:<session id>`. */
  ids: string[];
  roots?: HistoryRoots;
  lemonlimeHome: string;
  now?: () => Date;
}

/** `<agent>:<session id>`, split; null if it isn't one. */
export function parseHistoryId(id: string): { agent: HistoryAgent; sessionId: string } | null {
  const i = id.indexOf(":");
  if (i < 1) return null;
  const agent = HistoryAgent.safeParse(id.slice(0, i));
  const sessionId = id.slice(i + 1);
  if (!agent.success || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) return null;
  return { agent: agent.data, sessionId };
}

async function readTranscript(roots: HistoryRoots, agent: HistoryAgent, sessionId: string): Promise<Transcript | null> {
  if (agent === "claude-code") return readClaudeSession(roots["claude-code"], sessionId);
  if (agent === "codex") return readCodexSession(roots.codex, sessionId);
  return readOpenCodeSession(roots.opencode, sessionId);
}

/** What git printed, or null if it failed. Goes through the runner's own guarded git call. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return runGit(args, { cwd, timeout: 15_000 }).then(
    r => r.stdout.trim(),
    () => null,
  );
}

/** The repository a folder is in, and its current branch; or why it can't hold a thread. */
async function repoFor(cwd: string): Promise<{ repoPath: string; baseBranch: string } | { reason: string }> {
  let dir = false;
  try {
    dir = statSync(cwd).isDirectory();
  } catch {
    /* gone */
  }
  if (!dir) return { reason: `The folder it ran in, ${cwd}, no longer exists.` };
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return { reason: `${cwd} isn't a git repository, so the thread can't get its own branch there.` };
  const branch = await git(top, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return { repoPath: resolve(top), baseBranch: branch || "main" };
}

const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * Bring conversations in as local threads: each gets a new thread, its history written
 * where that thread's runner keeps it (as LemonLime events, with their original times),
 * and a recap the agent gets with the first new message. Importing the same conversation
 * again returns the thread it became (`already`), unless that thread was since deleted.
 */
export async function importHistory(o: ImportOptions): Promise<HistoryImportResult> {
  const roots = o.roots ?? defaultRoots();
  const now = o.now ?? (() => new Date());
  const isOwn = ownFolder(o.lemonlimeHome);
  const map = loadImports(o.lemonlimeHome);
  const result: HistoryImportResult = { imported: [], skipped: [] };
  const ids = [...new Set(o.ids)];
  for (const [i, id] of ids.entries()) {
    if (i >= MAX_IMPORT_IDS) {
      result.skipped.push({ id, reason: `Only ${MAX_IMPORT_IDS} conversations can be imported at once.` });
      continue;
    }
    const parsed = parseHistoryId(id);
    if (!parsed) {
      result.skipped.push({ id, reason: "That isn't a conversation id from a scan." });
      continue;
    }
    const done = importedThread(o.lemonlimeHome, map, id);
    if (done) {
      result.imported.push({ id, thread: done.thread, already: true });
      continue;
    }
    const name = HISTORY_AGENT_NAMES[parsed.agent];
    let transcript: Transcript | null;
    try {
      transcript = await readTranscript(roots, parsed.agent, parsed.sessionId);
    } catch {
      transcript = null;
    }
    if (!transcript) {
      result.skipped.push({ id, reason: `Couldn't find this conversation in ${name}'s history any more.` });
      continue;
    }
    const { info } = transcript;
    if (!transcript.events.some(e => e.event.type === "user_message" || e.event.type === "agent_message")) {
      result.skipped.push({ id, reason: "This conversation has no messages to import." });
      continue;
    }
    if (!info.cwd) {
      result.skipped.push({ id, reason: `${name} didn't record which folder this conversation ran in.` });
      continue;
    }
    if (isOwn(info.cwd)) {
      result.skipped.push({ id, reason: "This conversation is already a LemonLime thread." });
      continue;
    }
    const repo = await repoFor(info.cwd);
    if ("reason" in repo) {
      result.skipped.push({ id, reason: repo.reason });
      continue;
    }
    const thread = writeThread(o.lemonlimeHome, transcript, repo, now());
    map.sessions[id] = { threadId: thread.id, importedAt: now().toISOString(), thread };
    saveImports(o.lemonlimeHome, map);
    result.imported.push({ id, thread, already: false });
  }
  return result;
}

function writeThread(lemonlimeHome: string, t: Transcript, repo: { repoPath: string; baseBranch: string }, now: Date): ImportedThreadMeta {
  let id = newThreadId(now.getTime());
  while (existsSync(threadDir(lemonlimeHome, id))) id = newThreadId(now.getTime());
  const dir = threadDir(lemonlimeHome, id);
  mkdirSync(dir, { recursive: true });
  const store = new EventStore(id, join(dir, "events.jsonl"));
  const name = HISTORY_AGENT_NAMES[t.info.agent];
  const nowIso = now.toISOString();
  const events = t.events.length > MAX_IMPORT_EVENTS ? t.events.slice(-MAX_IMPORT_EVENTS) : t.events;
  const left = t.truncated || events.length < t.events.length;

  // Times only move forward, so the timeline reads in order even if a clock jumped.
  let last = t.info.startedAt;
  const at = (iso: string) => (last = iso > last ? iso : last);
  store.append(
    { type: "notice", code: "imported", message: `Imported from ${name}, where this conversation started on ${dateOf(t.info.startedAt)}.` },
    at(t.info.startedAt),
  );
  if (left)
    store.append(
      { type: "notice", code: "imported_partial", message: "This conversation was very long, so only its most recent part was imported." },
      at(events[0]?.at ?? t.info.startedAt),
    );
  for (const e of events) {
    try {
      store.append(e.event, at(e.at));
    } catch {
      /* an item that doesn't fit the history's shape is left out */
    }
  }
  const recap = recapBefore(
    store.since(0),
    store.latestSeq + 1,
    `This conversation started in ${name}, outside LemonLime, in ${t.info.cwd}, and was imported. Here is what was said, for context. ` +
      `You're now working in a separate copy of the repository on its own branch (made from ${repo.baseBranch}), so changes that weren't committed there aren't here:`,
  );
  store.append(
    {
      type: "notice",
      code: "imported_ready",
      message: `Imported on ${dateOf(nowIso)}. Your next message starts a new ${name} conversation on this thread's own branch, and the agent gets a recap of the one above.`,
    },
    at(nowIso),
  );
  // The runner picks the recap up when it starts and hands it over with the first message.
  writeFileSync(join(dir, "state.json"), JSON.stringify({ agentState: {}, status: "idle", queue: [], ...(recap ? { recap } : {}) }, null, 2));
  return {
    id,
    title: t.info.title || `${name} conversation`,
    agent: { kind: t.info.agent },
    repoPath: repo.repoPath,
    baseBranch: repo.baseBranch,
    branch: branchForThread(id),
    status: "idle",
    lastSeq: 0,
    createdAt: t.info.startedAt,
    updatedAt: t.info.updatedAt,
  };
}

export type { SessionInfo, Transcript };
