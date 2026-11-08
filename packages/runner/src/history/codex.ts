import { join } from "node:path";
import { entries, fileInfo, isoTime, oneLine, parseJson, readJsonLines, readLines, resolveRoot, scanRanges } from "./read.ts";
import { obj, str, textOf, TranscriptBuilder, type AgentListing, type SessionInfo, type Transcript } from "./types.ts";
import { MAX_IMPORT_BYTES } from "./claude-code.ts";

/**
 * Codex keeps each conversation as JSON Lines in
 * `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`. Each record is
 * `{timestamp, type, payload}`: `session_meta` (id, cwd), `turn_context`, `response_item`
 * (the model's messages, tool calls and their output) and `event_msg` (what the app
 * showed). Very old files have the items without the wrapper.
 * `<codex home>/session_index.jsonl` holds the names given to conversations.
 */

const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DIGITS = /^\d{1,4}$/;

interface SessionFile {
  sessionId: string;
  path: string;
  size: number;
  mtimeMs: number;
}

function sessionFiles(root: string): SessionFile[] | null {
  const real = resolveRoot(join(root, "sessions"));
  if (!real) return null;
  const out: SessionFile[] = [];
  for (const year of entries(real))
    if (year.dir && DIGITS.test(year.name))
      for (const month of entries(year.path))
        if (month.dir && DIGITS.test(month.name))
          for (const day of entries(month.path))
            if (day.dir && DIGITS.test(day.name))
              for (const f of entries(day.path)) {
                const m = ROLLOUT.exec(f.name);
                const info = !f.dir && m ? fileInfo(f.path) : null;
                if (m && info) out.push({ sessionId: m[1]!.toLowerCase(), path: f.path, ...info });
              }
  return out;
}

/** Names the user (or Codex) gave conversations, by session id. */
function sessionNames(root: string): Map<string, string> {
  const names = new Map<string, string>();
  const real = resolveRoot(root);
  if (!real) return names;
  const file = join(real, "session_index.jsonl");
  const info = fileInfo(file);
  if (!info) return names;
  // Newest names are at the end.
  for (const line of readLines(file, { start: Math.max(0, info.size - 8 * 1024 * 1024) })) {
    const r = obj(parseJson(line));
    const id = str(r?.id);
    const name = str(r?.thread_name);
    if (id && name) names.set(id.toLowerCase(), name);
  }
  return names;
}

export function listCodexSessions(root: string, sinceMs: number): AgentListing {
  const files = sessionFiles(root);
  if (!files) return { found: false, note: "No Codex history on this computer.", total: 0, sessions: [] };
  const names = sessionNames(root);
  const sessions: SessionInfo[] = [];
  for (const f of files) {
    if (f.mtimeMs < sinceMs) continue;
    const { ranges, partial } = scanRanges(f.size);
    const info = parseCodex(readJsonLines(f.path, ranges), f, names, false, partial).info;
    if (info) sessions.push(info);
  }
  return { found: true, total: files.length, sessions };
}

export function readCodexSession(root: string, sessionId: string): Transcript | null {
  const f = (sessionFiles(root) ?? []).filter(s => s.sessionId === sessionId.toLowerCase()).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!f) return null;
  const truncated = f.size > MAX_IMPORT_BYTES;
  // Read the start too, for the folder and session details in its first record.
  const ranges = truncated
    ? [
        { start: 0, end: 64 * 1024 },
        { start: f.size - MAX_IMPORT_BYTES, end: f.size },
      ]
    : [{ start: 0, end: f.size }];
  const { info, builder } = parseCodex(readJsonLines(f.path, ranges), f, sessionNames(root), true, false);
  return info ? { info, events: builder.events, truncated } : null;
}

/** Text Codex adds to the conversation itself (instructions, environment), not the user's. */
export function isInjected(text: string): boolean {
  const t = text.trimStart();
  return /^<[a-z][a-z0-9_-]*[\s>]/i.test(t) || t.startsWith("# AGENTS.md instructions");
}

function parseCodex(
  records: Iterable<Record<string, unknown>>,
  f: SessionFile,
  names: Map<string, string>,
  collect: boolean,
  partial: boolean,
): { info: SessionInfo | null; builder: TranscriptBuilder } {
  const items = new TranscriptBuilder(collect);
  // What the app showed, used only when a file has no model items (some versions).
  const shown = new TranscriptBuilder(collect);
  let cwd: string | null = null;
  let lastAt: string | null = null;
  for (const r of records) {
    const at: string | null = isoTime(r.timestamp) ?? lastAt;
    const wrapped = obj(r.payload);
    const type = wrapped ? r.type : "response_item";
    const p = wrapped ?? r;
    if (type === "session_meta" || type === "turn_context") {
      cwd ??= str(p.cwd);
      continue;
    }
    if (!at) continue;
    lastAt = at;
    if (type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim() && !isInjected(p.message)) {
        shown.saw(at);
        shown.user(at, p.message.trim());
      } else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
        shown.saw(at);
        shown.agent(at, p.message);
      }
      continue;
    }
    if (type !== "response_item") continue;
    switch (p.type) {
      case "message": {
        const text = textOf(p.content).trim();
        if (!text) break;
        if (p.role === "user" && !isInjected(text)) {
          items.saw(at);
          items.user(at, text);
        } else if (p.role === "assistant") {
          items.saw(at);
          items.agent(at, text);
        }
        break;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call":
      case "web_search_call": {
        const callId = str(p.call_id) ?? str(p.id);
        if (!callId) break;
        items.saw(at);
        const input = p.type === "function_call" ? argumentsOf(p.arguments) : p.type === "custom_tool_call" ? p.input : p.action;
        const name = str(p.name) ?? (p.type === "local_shell_call" ? "shell" : p.type === "web_search_call" ? "web_search" : "tool");
        items.toolCall(at, callId, name, input);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = str(p.call_id);
        if (!callId) break;
        const out = obj(p.output);
        items.toolResult(at, callId, out && "content" in out ? out.content : p.output, out?.success === false);
        break;
      }
    }
  }
  const b = items.messages ? items : shown.messages ? shown : items;
  if (!b.firstAt) return { info: null, builder: b };
  const info: SessionInfo = {
    agent: "codex",
    sessionId: f.sessionId,
    title: oneLine(names.get(f.sessionId) ?? b.firstPrompt ?? ""),
    cwd,
    startedAt: b.firstAt,
    updatedAt: b.lastAt ?? b.firstAt,
    messageCount: b.messages,
    partial,
    days: b.days,
  };
  return { info, builder: b };
}

function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const parsed = parseJson(raw);
  return parsed ?? raw;
}
