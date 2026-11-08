import { join } from "node:path";
import { entries, fileInfo, isoTime, oneLine, readJsonFile, resolveRoot } from "./read.ts";
import { obj, str, TranscriptBuilder, type AgentListing, type SessionInfo, type Transcript } from "./types.ts";

/**
 * OpenCode keeps its history under its data folder (`$XDG_DATA_HOME/opencode`, usually
 * `~/.local/share/opencode`). Current versions use one SQLite database, `opencode.db`,
 * with `session`, `message` and `part` tables whose `data` column is JSON; older versions
 * wrote one JSON file per item under `storage/session/<project>/`, `storage/message/<session>/`
 * and `storage/part/<message>/`. Both are read; the database is opened read-only.
 */

/** Most rows read from any one table, however big the database grows. */
const MAX_ROWS = 200_000;
/** Most JSON files read from the older storage. */
const MAX_FILES = 20_000;

interface Row {
  id: string;
  messageId?: string;
  at: string;
  data: Record<string, unknown>;
}

interface RawSession {
  id: string;
  title: string;
  cwd: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Read access to one of OpenCode's two layouts. */
interface Store {
  sessions(): RawSession[];
  /** Messages per session (ordered), each with its parts' rows. */
  messages(sessionId?: string): Map<string, Row[]>;
  parts(sessionId: string): Row[];
  /** Replies with text per session, when the layout can tell cheaply. */
  replyCounts(): Map<string, number> | null;
  /** The first thing the user wrote in a session. */
  firstPrompt(sessionId: string): string | null;
  close(): void;
}

type Db = {
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
};

async function openDb(file: string): Promise<Db | null> {
  if (!fileInfo(file)) return null;
  try {
    // Built into Node 22.5 and later; older Node simply doesn't read the database.
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string, o: { readOnly: boolean }) => Db };
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

const parse = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "string") return {};
  try {
    return obj(JSON.parse(v)) ?? {};
  } catch {
    return {};
  }
};

/** Whether a message part is something the user or the agent wrote (not a placeholder). */
const shownText = (d: Record<string, unknown>): boolean =>
  d.type === "text" && typeof d.text === "string" && d.text.trim() !== "" && d.synthetic !== true && d.ignored !== true;

function dbStore(db: Db): Store {
  return {
    sessions: () =>
      db
        .prepare(`SELECT * FROM session LIMIT ${MAX_ROWS}`)
        .all()
        .filter(r => !r.parent_id) // subagents' conversations
        .map(r => ({
          id: String(r.id),
          title: str(r.title) ?? "",
          cwd: str(r.directory),
          createdAt: isoTime(Number(r.time_created)),
          updatedAt: isoTime(Number(r.time_updated)),
        })),
    messages: sessionId => {
      const rows = sessionId
        ? db.prepare(`SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ${MAX_ROWS}`).all(sessionId)
        : db.prepare(`SELECT id, session_id, time_created, data FROM message ORDER BY session_id, time_created, id LIMIT ${MAX_ROWS}`).all();
      const out = new Map<string, Row[]>();
      for (const r of rows) {
        const at = isoTime(Number(r.time_created));
        if (!at) continue;
        const sid = String(r.session_id);
        const list = out.get(sid) ?? [];
        list.push({ id: String(r.id), at, data: parse(r.data) });
        out.set(sid, list);
      }
      return out;
    },
    parts: sessionId =>
      db
        .prepare(`SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY message_id, id LIMIT ${MAX_ROWS}`)
        .all(sessionId)
        .flatMap(r => {
          const at = isoTime(Number(r.time_created));
          return at ? [{ id: String(r.id), messageId: String(r.message_id), at, data: parse(r.data) }] : [];
        }),
    replyCounts: () => {
      try {
        const rows = db
          .prepare(
            `SELECT p.session_id AS sid, COUNT(DISTINCT p.message_id) AS n FROM part p JOIN message m ON m.id = p.message_id
             WHERE json_extract(p.data, '$.type') = 'text' AND json_extract(m.data, '$.role') = 'assistant' GROUP BY p.session_id`,
          )
          .all();
        return new Map(rows.map(r => [String(r.sid), Number(r.n) || 0]));
      } catch {
        return null;
      }
    },
    firstPrompt: sessionId => {
      try {
        const rows = db
          .prepare(
            `SELECT p.data AS data FROM part p JOIN message m ON m.id = p.message_id
             WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user' ORDER BY m.time_created, p.id LIMIT 20`,
          )
          .all(sessionId);
        const text = rows.map(r => parse(r.data)).find(shownText)?.text;
        return typeof text === "string" ? text.trim() : null;
      } catch {
        return null;
      }
    },
    close: () => db.close(),
  };
}

/** The older layout: one JSON file per session, message and part. */
function fileStore(storage: string): Store {
  let budget = MAX_FILES;
  const jsonFiles = (dir: string) =>
    entries(dir)
      .filter(e => !e.dir && e.name.endsWith(".json") && budget-- > 0)
      .map(e => readJsonFile(e.path))
      .filter((d): d is Record<string, unknown> => d !== null);
  const time = (d: Record<string, unknown>, key: "created" | "updated") => isoTime(obj(d.time)?.[key] as number);
  const messagesOf = (sid: string): Row[] =>
    jsonFiles(join(storage, "message", sid))
      .flatMap(d => {
        const id = str(d.id);
        const at = time(d, "created");
        return id && at ? [{ id, at, data: d }] : [];
      })
      .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
  return {
    sessions: () =>
      entries(join(storage, "session"))
        .filter(e => e.dir)
        .flatMap(project => jsonFiles(project.path))
        .filter(d => str(d.id) && !d.parentID)
        .map(d => ({ id: String(d.id), title: str(d.title) ?? "", cwd: str(d.directory), createdAt: time(d, "created"), updatedAt: time(d, "updated") })),
    messages: sessionId => {
      const out = new Map<string, Row[]>();
      const ids = sessionId
        ? [sessionId]
        : entries(join(storage, "message"))
            .filter(e => e.dir)
            .map(e => e.name);
      for (const sid of ids) out.set(sid, messagesOf(sid));
      return out;
    },
    parts: sessionId =>
      messagesOf(sessionId).flatMap(m =>
        jsonFiles(join(storage, "part", m.id))
          .filter(d => str(d.id))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map(d => ({ id: String(d.id), messageId: m.id, at: time(d, "created") ?? m.at, data: d })),
      ),
    replyCounts: () => null,
    firstPrompt: sessionId => {
      const first = messagesOf(sessionId).find(m => m.data.role === "user");
      const text = first ? jsonFiles(join(storage, "part", first.id)).find(shownText)?.text : null;
      return typeof text === "string" ? text.trim() : null;
    },
    close: () => undefined,
  };
}

async function openStore(root: string): Promise<{ store: Store } | { note: string }> {
  const real = resolveRoot(root);
  if (!real) return { note: "No OpenCode history on this computer." };
  const db = await openDb(join(real, "opencode.db"));
  if (db) {
    try {
      db.prepare("SELECT id FROM session LIMIT 1").all();
      return { store: dbStore(db) };
    } catch {
      db.close();
      return { note: "OpenCode's history is in a format LemonLime can't read yet." };
    }
  }
  if (fileInfo(join(real, "opencode.db"))) return { note: "OpenCode's history needs a newer Node.js to read (22.5 or later)." };
  const storage = resolveRoot(join(real, "storage"));
  if (storage && resolveRoot(join(storage, "session"))) return { store: fileStore(storage) };
  return { note: "No OpenCode history on this computer." };
}

export async function listOpenCodeSessions(root: string, sinceMs: number): Promise<AgentListing> {
  const opened = await openStore(root);
  if ("note" in opened) return { found: false, note: opened.note, total: 0, sessions: [] };
  const { store } = opened;
  try {
    const raw = store.sessions();
    const recent = raw.filter(s => !s.updatedAt || Date.parse(s.updatedAt) >= sinceMs);
    const messages = recent.length ? store.messages() : new Map<string, Row[]>();
    const replies = recent.length ? store.replyCounts() : null;
    const sessions: SessionInfo[] = [];
    for (const s of recent) {
      const b = new TranscriptBuilder(false);
      let users = 0;
      for (const m of messages.get(s.id) ?? []) {
        b.saw(m.at);
        if (m.data.role === "user") users++;
      }
      if (!b.firstAt && !s.createdAt) continue;
      if (isPlaceholder(s.title)) b.firstPrompt = store.firstPrompt(s.id);
      // The agent writes a message per step, so its replies are the ones with text; when
      // that can't be told cheaply, assume one reply per user message.
      sessions.push(info(s, b, users + (replies ? (replies.get(s.id) ?? 0) : users)));
    }
    return { found: true, total: raw.length, sessions };
  } catch {
    return { found: true, note: "Some of OpenCode's history couldn't be read.", total: 0, sessions: [] };
  } finally {
    store.close();
  }
}

export async function readOpenCodeSession(root: string, sessionId: string): Promise<Transcript | null> {
  const opened = await openStore(root);
  if ("note" in opened) return null;
  const { store } = opened;
  try {
    const s = store.sessions().find(x => x.id === sessionId);
    if (!s) return null;
    const messages = store.messages(sessionId).get(sessionId) ?? [];
    const role = new Map(messages.map(m => [m.id, m.data.role]));
    const order = new Map(messages.map((m, i) => [m.id, i]));
    const parts = store.parts(sessionId).sort((a, b) => (order.get(a.messageId!) ?? 0) - (order.get(b.messageId!) ?? 0));
    const b = new TranscriptBuilder(true);
    for (const m of messages) b.saw(m.at);
    let users = 0;
    let replies = 0;
    let lastReplyMessage: string | null = null;
    for (const p of parts) {
      const d = p.data;
      const who = role.get(p.messageId!);
      if (who === "user") {
        if (shownText(d)) {
          b.user(p.at, String(d.text).trim());
          users++;
        }
      } else if (who === "assistant") {
        if (shownText(d)) {
          b.agent(p.at, String(d.text));
          if (lastReplyMessage !== p.messageId) replies++;
          lastReplyMessage = p.messageId!;
        } else if (d.type === "tool") {
          const callId = str(d.callID) ?? p.id;
          const state = obj(d.state) ?? {};
          b.toolCall(p.at, callId, str(d.tool) ?? "tool", state.input);
          if (state.status === "completed") b.toolResult(p.at, callId, state.output, false);
          else if (state.status === "error") b.toolResult(p.at, callId, state.error, true);
        }
      }
    }
    b.messages = users + replies;
    return { info: info(s, b, b.messages), events: b.events, truncated: false };
  } catch {
    return null;
  } finally {
    store.close();
  }
}

/** OpenCode names new conversations "New session - <time>" until it thinks of a title. */
const isPlaceholder = (title: string) => !title || title.startsWith("New session - ");

function info(s: RawSession, b: TranscriptBuilder, messageCount: number): SessionInfo {
  const startedAt = b.firstAt ?? s.createdAt ?? s.updatedAt!;
  const title = isPlaceholder(s.title) ? (b.firstPrompt ?? "") : s.title;
  return {
    agent: "opencode",
    sessionId: s.id,
    title: oneLine(title),
    cwd: s.cwd,
    startedAt,
    updatedAt: b.lastAt ?? s.updatedAt ?? startedAt,
    messageCount,
    partial: false,
    days: b.days,
  };
}
