import { z } from "zod";
import { AgentConfig, ThreadId } from "./thread.ts";

/**
 * Conversations the user already had with a coding agent on this computer, outside
 * LemonLime, found by `lemonlime-runner history scan` and brought in as local threads by
 * `lemonlime-runner history import`. The originals are only ever read.
 */

/** Agents whose saved conversations can be read. */
export const HistoryAgent = z.enum(["claude-code", "codex", "opencode"]);
export type HistoryAgent = z.infer<typeof HistoryAgent>;

/** What people call each agent, for messages and the app. */
export const HISTORY_AGENT_NAMES: Record<HistoryAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * One saved conversation. `id` is `<agent>:<the agent's own session id>`, unique across
 * agents; pass it to import.
 */
export const HistorySession = z.object({
  id: z.string(),
  agent: HistoryAgent,
  /** The agent's own id for the conversation. */
  sessionId: z.string(),
  /** Its title, else its first prompt (trimmed), else "". */
  title: z.string(),
  /** Folder it ran in, when the agent recorded one. */
  cwd: z.string().nullable(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Messages from the user and replies from the agent (tool calls aren't counted). */
  messageCount: z.number().int().nonnegative(),
  /** The file was too big to read whole, so `messageCount` covers its start and end only. */
  partial: z.boolean().default(false),
  /** Already imported: the LemonLime thread it became. */
  importedThreadId: ThreadId.optional(),
});
export type HistorySession = z.infer<typeof HistorySession>;

/** A folder an agent was used in. */
export const HistoryFolder = z.object({
  path: z.string(),
  sessions: z.number().int().nonnegative(),
  /** When the newest of those conversations was last updated. */
  lastUsed: z.string().datetime(),
});
export type HistoryFolder = z.infer<typeof HistoryFolder>;

export const AgentHistoryScan = z.object({
  /** The agent's history was found on this computer. */
  found: z.boolean(),
  /** Every saved conversation, however old. */
  sessions: z.number().int().nonnegative(),
  /** Conversations updated within the scan's `sinceDays`. */
  inRange: z.number().int().nonnegative(),
  /**
   * Conversations active on each day of the last 365 (local dates, "YYYY-MM-DD"); a
   * conversation counts once on every day it had messages. Days with none are left out.
   */
  perDay: z.record(z.string(), z.number().int().positive()),
  /** Folders of the conversations in range, most recently used first. */
  folders: z.array(HistoryFolder),
  /** Why nothing was found or read, in words a user can act on. */
  note: z.string().optional(),
});
export type AgentHistoryScan = z.infer<typeof AgentHistoryScan>;

export const HistoryScan = z.object({
  scannedAt: z.string().datetime(),
  sinceDays: z.number().int().positive(),
  agents: z.object({ "claude-code": AgentHistoryScan, codex: AgentHistoryScan, opencode: AgentHistoryScan }),
  /** Conversations in range, newest first (capped by the scan's limit). */
  sessions: z.array(HistorySession),
});
export type HistoryScan = z.infer<typeof HistoryScan>;

/**
 * A local thread made from an imported conversation, in the shape the desktop app keeps
 * local threads (its LocalThreadMeta).
 */
export const ImportedThreadMeta = z.object({
  id: ThreadId,
  title: z.string(),
  agent: AgentConfig,
  /** The git repository the conversation ran in. */
  repoPath: z.string(),
  /** That repository's current branch when it was imported. */
  baseBranch: z.string(),
  branch: z.string(),
  status: z.literal("idle"),
  lastSeq: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImportedThreadMeta = z.infer<typeof ImportedThreadMeta>;

export const HistoryImportResult = z.object({
  imported: z.array(
    z.object({
      /** The `id` that was asked for. */
      id: z.string(),
      thread: ImportedThreadMeta,
      /** It had been imported before; this is that same thread, nothing new was written. */
      already: z.boolean(),
    }),
  ),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type HistoryImportResult = z.infer<typeof HistoryImportResult>;
