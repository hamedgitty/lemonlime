import { join } from "node:path";
import { entries, fileInfo, isoTime, oneLine, readJsonLines, resolveRoot, scanRanges } from "./read.ts";
import { obj, str, textOf, TranscriptBuilder, type AgentListing, type SessionInfo, type Transcript } from "./types.ts";

/**
 * Claude Code keeps each conversation as JSON Lines in
 * `<config>/projects/<the folder's path, encoded>/<session id>.jsonl`: one record per
 * user or assistant message (each carrying `cwd`, `timestamp` and `sessionId`), plus
 * bookkeeping records (`summary`, `custom-title`, snapshots, request logs, ...).
 * Subagents' conversations live in folders beside them and aren't listed.
 */

/** Biggest part of one conversation file read for import (its newest part). */
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.jsonl$/;

interface SessionFile {
  sessionId: string;
  path: string;
  size: number;
  mtimeMs: number;
}

function sessionFiles(root: string): SessionFile[] | null {
  const real = resolveRoot(join(root, "projects"));
  if (!real) return null;
  const out: SessionFile[] = [];
  for (const project of entries(real)) {
    if (!project.dir) continue;
    for (const f of entries(project.path)) {
      const m = SESSION_FILE.exec(f.name);
      const info = !f.dir && m ? fileInfo(f.path) : null;
      if (m && info) out.push({ sessionId: m[1]!, path: f.path, ...info });
    }
  }
  return out;
}

/** Every Claude Code conversation; the ones changed since `sinceMs` are read (quickly). */
export function listClaudeSessions(root: string, sinceMs: number): AgentListing {
  const files = sessionFiles(root);
  if (!files) return { found: false, note: "No Claude Code history on this computer.", total: 0, sessions: [] };
  const sessions: SessionInfo[] = [];
  for (const f of files) {
    if (f.mtimeMs < sinceMs) continue;
    const { ranges, partial } = scanRanges(f.size);
    const info = parseClaude(readJsonLines(f.path, ranges), f, false, partial).info;
    if (info) sessions.push(info);
  }
  return { found: true, total: files.length, sessions };
}

/** One conversation in full (or its newest part, when it's enormous). */
export function readClaudeSession(root: string, sessionId: string): Transcript | null {
  const candidates = (sessionFiles(root) ?? []).filter(f => f.sessionId === sessionId).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const f = candidates[0];
  if (!f) return null;
  const truncated = f.size > MAX_IMPORT_BYTES;
  const range = { start: truncated ? f.size - MAX_IMPORT_BYTES : 0, end: f.size };
  const { info, builder } = parseClaude(readJsonLines(f.path, [range]), f, true, false);
  return info ? { info, events: builder.events, truncated } : null;
}

function parseClaude(
  records: Iterable<Record<string, unknown>>,
  f: SessionFile,
  collect: boolean,
  partial: boolean,
): { info: SessionInfo | null; builder: TranscriptBuilder } {
  const b = new TranscriptBuilder(collect);
  let cwd: string | null = null;
  let customTitle: string | null = null;
  let summary: string | null = null;
  for (const r of records) {
    const type = r.type;
    if (type === "custom-title") customTitle = str(r.customTitle) ?? customTitle;
    else if (type === "summary") summary ??= str(r.summary);
    if ((type !== "user" && type !== "assistant") || r.isSidechain === true) continue;
    cwd ??= str(r.cwd);
    const at = isoTime(r.timestamp);
    if (!at) continue;
    const message = obj(r.message);
    if (!message) continue;
    if (type === "user") {
      if (r.isMeta === true || r.isCompactSummary === true || r.isVisibleInTranscriptOnly === true) continue;
      const content = message.content;
      const texts: string[] = [];
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        for (const raw of content) {
          const block = obj(raw);
          if (!block) continue;
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
          else if (block.type === "image") texts.push("[image]");
          else if (block.type === "tool_result" && typeof block.tool_use_id === "string")
            b.toolResult(at, block.tool_use_id, textOf(block.content), block.is_error === true);
        }
      }
      const text = cleanUserText(texts.join("\n"));
      if (text) {
        b.saw(at);
        b.user(at, text);
      } else if (texts.length === 0) b.saw(at); // a tool result: still activity
    } else {
      if (r.isApiErrorMessage === true || message.model === "<synthetic>") continue;
      b.saw(at);
      if (!Array.isArray(message.content)) continue;
      for (const raw of message.content) {
        const block = obj(raw);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) b.agent(at, block.text);
        else if (block.type === "tool_use" && typeof block.id === "string") b.toolCall(at, block.id, str(block.name) ?? "tool", block.input);
      }
    }
  }
  if (!b.firstAt && !b.messages) return { info: null, builder: b };
  const fallback = new Date(f.mtimeMs).toISOString();
  const info: SessionInfo = {
    agent: "claude-code",
    sessionId: f.sessionId,
    title: oneLine(customTitle ?? summary ?? b.firstPrompt ?? ""),
    cwd,
    startedAt: b.firstAt ?? fallback,
    updatedAt: b.lastAt ?? fallback,
    messageCount: b.messages,
    partial,
    days: b.days,
  };
  return { info, builder: b };
}

/**
 * What the user actually typed, without what Claude Code wraps around it: slash commands
 * become `/name args`, `!` shell commands `! cmd`, their output and other notes are
 * dropped (null), and system reminders added by hooks are removed.
 */
export function cleanUserText(raw: string): string | null {
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text) return null;
  if (/^(<local-command-(stdout|stderr|caveat)>|<bash-(stdout|stderr)>|Caveat: The messages below)/.test(text)) return null;
  if (text.startsWith("[Request interrupted by user")) return null;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`;
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(text)?.[1];
  if (bash !== undefined) return `! ${bash.trim()}`;
  text = text.trim();
  return text || null;
}
