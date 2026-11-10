import { and, count, eq, inArray } from "drizzle-orm";
import { pendingMessages, threads, type ThreadRow } from "@lemonlime/db";
import { ThreadEvent, type PendingMessage, type RunnerHistoryResponse, type ThreadHistoryResponse } from "@lemonlime/protocol";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";

/**
 * Where thread history is kept once it has left the sandbox, so a thread can be read
 * (and its sandbox deleted) without waking anything. Objects are JSON Lines chunks named
 * `threads/<id>/<first seq>-<last seq>.jsonl`, zero-padded so they sort in order.
 */
export interface HistoryStore {
  readonly kind: string;
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  /** Remove these objects; ones already gone are fine. */
  delete(keys: readonly string[]): Promise<void>;
}

/** The subset of Cloudflare's R2 bucket binding we use. */
interface R2Like {
  put(key: string, body: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

export function r2HistoryStore(bucket: R2Like): HistoryStore {
  return {
    kind: "r2",
    async put(key, body) {
      await bucket.put(key, body);
    },
    async get(key) {
      const obj = await bucket.get(key);
      return obj ? obj.text() : null;
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.objects.map(o => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
    async delete(keys) {
      // R2 takes up to 1,000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    },
  };
}

/** A folder on disk, for Node deployments. */
export function fileHistoryStore(dir: string): HistoryStore {
  const fs = () => import("node:fs/promises");
  const path = () => import("node:path");
  return {
    kind: "file",
    async put(key, body) {
      const [{ mkdir, writeFile }, { dirname, join }] = await Promise.all([fs(), path()]);
      const file = join(dir, key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    },
    async get(key) {
      const [{ readFile }, { join }] = await Promise.all([fs(), path()]);
      return readFile(join(dir, key), "utf8").catch(() => null);
    },
    async list(prefix) {
      const [{ readdir }, { join }] = await Promise.all([fs(), path()]);
      const folder = prefix.replace(/\/[^/]*$/, "");
      const names = await readdir(join(dir, folder)).catch(() => [] as string[]);
      return names.map(n => `${folder}/${n}`).filter(k => k.startsWith(prefix));
    },
    async delete(keys) {
      const [{ rm }, { join }] = await Promise.all([fs(), path()]);
      for (const key of keys) await rm(join(dir, key), { force: true });
    },
  };
}

export function memoryHistoryStore(): HistoryStore & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    kind: "memory",
    objects,
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async list(prefix) {
      return [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
    },
    async delete(keys) {
      for (const key of keys) objects.delete(key);
    },
  };
}

const pad = (n: number) => String(n).padStart(12, "0");
const prefixFor = (threadId: string) => `threads/${threadId}/`;

function parseKey(key: string): { from: number; to: number } | null {
  const m = /\/(\d{12})-(\d{12})\.jsonl$/.exec(key);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null;
}

/**
 * Keep the next part of a thread's history. Safe to retry: events the store already has
 * are skipped, and a gap (events that skip ahead) stores nothing and says where to resume.
 */
export async function appendHistory(ctx: AppContext, row: ThreadRow, events: readonly ThreadEvent[]): Promise<RunnerHistoryResponse> {
  if (!ctx.history) throw new HttpError(501, "History storage is not set up on this control plane.");
  if (events.some(e => e.threadId !== row.id)) throw new HttpError(400, "Events belong to another thread.");
  const fresh = events.filter(e => e.seq > row.historySeq);
  if (fresh.length === 0) return { storedSeq: row.historySeq };
  if (fresh[0]!.seq !== row.historySeq + 1) return { storedSeq: row.historySeq };
  for (let i = 1; i < fresh.length; i++) if (fresh[i]!.seq !== fresh[i - 1]!.seq + 1) throw new HttpError(400, "Events must have consecutive seq numbers.");

  const from = fresh[0]!.seq;
  const to = fresh.at(-1)!.seq;
  await ctx.history.put(`${prefixFor(row.id)}${pad(from)}-${pad(to)}.jsonl`, fresh.map(e => JSON.stringify(e)).join("\n") + "\n");
  // Only move forward; a slower duplicate upload can't wind the counter back.
  const [updated] = await ctx.db
    .update(threads)
    .set({ historySeq: to })
    .where(and(eq(threads.id, row.id), eq(threads.historySeq, row.historySeq)))
    .returning({ historySeq: threads.historySeq });
  if (updated) return { storedSeq: updated.historySeq };
  const [current] = await ctx.db.select({ historySeq: threads.historySeq }).from(threads).where(eq(threads.id, row.id));
  return { storedSeq: current?.historySeq ?? row.historySeq };
}

/** Delete everything stored for a thread. */
export async function deleteHistory(ctx: AppContext, threadId: string): Promise<void> {
  if (!ctx.history) return;
  await ctx.history.delete(await ctx.history.list(prefixFor(threadId)));
}

/** Stored history after `after`, oldest first, at most `limit` events. */
export async function readHistory(ctx: AppContext, threadId: string, after: number, limit = 2000): Promise<ThreadHistoryResponse> {
  if (!ctx.history) return { events: [], more: false };
  const chunks = (await ctx.history.list(prefixFor(threadId)))
    .map(key => ({ key, range: parseKey(key) }))
    .filter((c): c is { key: string; range: { from: number; to: number } } => c.range !== null && c.range.to > after)
    .sort((a, b) => a.range.from - b.range.from);
  const events: ThreadEvent[] = [];
  let last = after;
  for (const chunk of chunks) {
    const body = await ctx.history.get(chunk.key);
    if (!body) continue;
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const parsed = ThreadEvent.safeParse(JSON.parse(line));
      if (!parsed.success || parsed.data.seq <= last) continue;
      if (parsed.data.seq !== last + 1) return { events, more: false }; // a gap: stop at what is complete
      if (events.length >= limit) return { events, more: true };
      events.push(parsed.data);
      last = parsed.data.seq;
    }
  }
  return { events, more: false };
}

/**
 * The agent's last whole message in a thread's stored history, or null. Reads the newest
 * chunks only (a few at most), so it stays cheap on long threads.
 */
export async function lastAgentMessage(ctx: AppContext, threadId: string, maxChunks = 3): Promise<string | null> {
  if (!ctx.history) return null;
  const chunks = (await ctx.history.list(prefixFor(threadId)))
    .map(key => ({ key, range: parseKey(key) }))
    .filter((c): c is { key: string; range: { from: number; to: number } } => c.range !== null)
    .sort((a, b) => b.range.to - a.range.to)
    .slice(0, maxChunks);
  for (const chunk of chunks) {
    const lines = ((await ctx.history.get(chunk.key)) ?? "").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"agent_message"')) continue;
      const parsed = ThreadEvent.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.type === "agent_message" && !parsed.data.partial && parsed.data.text.trim()) return parsed.data.text;
    }
  }
  return null;
}

/**
 * How a thread's stored history ends: the agent's last whole message, and the code of an
 * error that came after it (the turn failed), if any. Reads the newest chunks only.
 */
export async function threadEnding(ctx: AppContext, threadId: string, maxChunks = 3): Promise<{ message: string | null; errorCode: string | null }> {
  if (!ctx.history) return { message: null, errorCode: null };
  const chunks = (await ctx.history.list(prefixFor(threadId)))
    .map(key => ({ key, range: parseKey(key) }))
    .filter((c): c is { key: string; range: { from: number; to: number } } => c.range !== null)
    .sort((a, b) => b.range.to - a.range.to)
    .slice(0, maxChunks);
  let errorCode: string | null = null;
  for (const chunk of chunks) {
    const lines = ((await ctx.history.get(chunk.key)) ?? "").split("\n").reverse();
    for (const line of lines) {
      const isError = line.includes('"type":"error"');
      if (!isError && !line.includes('"agent_message"')) continue;
      const parsed = ThreadEvent.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const e = parsed.data;
      if (e.type === "error" && errorCode === null) errorCode = e.code ?? "agent_failed";
      if (e.type === "agent_message" && !e.partial && e.text.trim()) return { message: e.text, errorCode };
    }
  }
  return { message: null, errorCode };
}

// ─── Messages sent while the sandbox was paused ─────────────────────────────

/**
 * Save a message for a thread whose runner isn't reachable. Sending the same id twice is a
 * no-op. Only automations set `check`; messages from people never carry one.
 */
export async function addPendingMessage(ctx: AppContext, threadId: string, msg: PendingMessage): Promise<void> {
  await ctx.db
    .insert(pendingMessages)
    .values({ threadId, clientMsgId: msg.clientMsgId, text: msg.text, check: msg.check?.trim() || null })
    .onConflictDoNothing();
}

/** The most messages that can wait for one thread. */
export const PENDING_MESSAGES_MAX = 50;

/**
 * Like `addPendingMessage`, for messages people send: when the thread already has as many
 * waiting as it may, nothing is saved and the answer is false. Sending one that is already
 * waiting again is still fine.
 */
export async function addPendingMessageIfRoom(ctx: AppContext, threadId: string, msg: PendingMessage): Promise<boolean> {
  if ((await countPendingMessages(ctx, threadId)) >= PENDING_MESSAGES_MAX) {
    const [waiting] = await ctx.db
      .select({ id: pendingMessages.id })
      .from(pendingMessages)
      .where(and(eq(pendingMessages.threadId, threadId), eq(pendingMessages.clientMsgId, msg.clientMsgId)))
      .limit(1);
    return Boolean(waiting);
  }
  await addPendingMessage(ctx, threadId, msg);
  return true;
}

export async function listPendingMessages(ctx: AppContext, threadId: string): Promise<PendingMessage[]> {
  const rows = await ctx.db.select().from(pendingMessages).where(eq(pendingMessages.threadId, threadId)).orderBy(pendingMessages.id);
  return rows.map(r => ({ clientMsgId: r.clientMsgId, text: r.text, ...(r.check ? { check: r.check } : {}) }));
}

export async function countPendingMessages(ctx: AppContext, threadId: string): Promise<number> {
  const [row] = await ctx.db.select({ n: count() }).from(pendingMessages).where(eq(pendingMessages.threadId, threadId));
  return row?.n ?? 0;
}

/** The runner has these now (queued or in its history); forget them here. */
export async function ackPendingMessages(ctx: AppContext, threadId: string, clientMsgIds: readonly string[]): Promise<void> {
  if (clientMsgIds.length === 0) return;
  await ctx.db.delete(pendingMessages).where(and(eq(pendingMessages.threadId, threadId), inArray(pendingMessages.clientMsgId, [...clientMsgIds])));
}
