import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { accessTokens, computers, threads, workspaceMembers, workspaces, type ComputerRow, type Db, type ThreadRow } from "@lemonlime/db";
import { HttpError } from "./errors.ts";

/**
 * Authorization. SQLite has no row-level security, so every read or write a
 * user makes goes through this module, which checks that the user belongs to
 * the workspace (threads) or owns the row (access tokens).
 *
 * Rules:
 * - A user sees threads only in workspaces they are a member of. Threads in other
 *   workspaces are reported as "not found", never "forbidden", so ids do not leak.
 * - Every member can read a thread. Only the person who started it can take part in it
 *   (message the agent, reach its sandbox, rename it, wake it), unless they share it with
 *   the workspace. A thread whose starter has left can only be read.
 * - Asking for a workspace you are not in is a 403.
 * - Access tokens belong to one user; only that user can list or revoke them. A token that
 *   goes unused for 90 days stops working.
 * - Computers (phone access to local threads) belong to one user: only that user sees or
 *   reaches them, and only while still a member of the workspace the computer is in.
 *
 * The runner heartbeat and the scheduled sweep are not user requests: they are
 * authenticated by the thread's runner token and the cron secret instead.
 */

// ─── Workspaces ──────────────────────────────────────────────────────────────

/** A workspace name from an email address: its local part, or "Personal". */
export function personalWorkspaceName(email: string | null | undefined): string {
  const local = email?.split("@")[0]?.trim() ?? "";
  return (local || "Personal").slice(0, 200);
}

/** Create a personal workspace owned by the user. Called when a user signs up. */
export async function createPersonalWorkspace(db: Db, userId: string, email: string | null | undefined): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(workspaces).values({ id, name: personalWorkspaceName(email), personal: true, createdBy: userId });
  await db.insert(workspaceMembers).values({ workspaceId: id, userId, role: "owner" });
  return id;
}

/**
 * Workspaces the user belongs to: their personal workspace first (the default),
 * then the rest by oldest membership. Creates a personal one if there is none.
 * Timestamps can tie, so the personal flag decides the default, not creation time.
 */
export async function userWorkspaceIds(db: Db, userId: string, email?: string | null): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(desc(sql`(${workspaces.personal} AND ${workspaces.createdBy} = ${userId})`), asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId));
  if (rows.length) return rows.map(r => r.workspaceId);
  // Normally created at sign-up (see better-auth.ts); this covers anything created before that hook ran.
  return [await createPersonalWorkspace(db, userId, email)];
}

export async function isWorkspaceMember(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  const row = await db
    .select({ one: sql<number>`1` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .get();
  return row !== undefined;
}

/** Throws 403 unless the user is a member of the workspace. */
export async function requireWorkspaceMember(db: Db, userId: string, workspaceId: string): Promise<void> {
  if (!(await isWorkspaceMember(db, userId, workspaceId))) throw new HttpError(403, "You are not a member of that workspace.");
}

/** The workspace to act in: the requested one if the user is a member (else 403), or their first. */
export async function resolveWorkspace(db: Db, userId: string, requested?: string | null): Promise<string> {
  if (requested) {
    await requireWorkspaceMember(db, userId, requested);
    return requested;
  }
  return (await userWorkspaceIds(db, userId))[0]!;
}

// ─── Threads ─────────────────────────────────────────────────────────────────

/** The thread, if the user is a member of its workspace; otherwise null. */
export async function findThreadForUser(db: Db, userId: string, threadId: string): Promise<ThreadRow | null> {
  const row = await db
    .select({ thread: threads })
    .from(threads)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, threads.workspaceId), eq(workspaceMembers.userId, userId)))
    .where(eq(threads.id, threadId))
    .get();
  return row?.thread ?? null;
}

/** The thread, if the user is a member of its workspace; otherwise 404. */
export async function getThreadForUser(db: Db, userId: string, threadId: string): Promise<ThreadRow> {
  const row = await findThreadForUser(db, userId, threadId);
  if (!row) throw new HttpError(404, "Thread not found.");
  return row;
}

export const ONLY_THE_STARTER = "Only the person who started this thread can do that, unless they share it with the workspace.";
export const STARTER_HAS_LEFT = "The person who started this thread has left the workspace, so it can only be read.";

/** Whether the thread is this user's own. A thread whose starter is gone is nobody's. */
export function startedBy(row: Pick<ThreadRow, "createdBy">, userId: string): boolean {
  return row.createdBy !== null && row.createdBy === userId;
}

/** Whether the starter has opened the thread to the rest of the workspace. Nobody can share a thread whose starter is gone. */
export function sharedWithWorkspace(row: Pick<ThreadRow, "createdBy" | "shared">): boolean {
  return row.createdBy !== null && row.shared;
}

/**
 * Whether a workspace member may direct the thread's agent and reach its sandbox: the
 * person who started it, or anyone in the workspace once the starter has shared it.
 * Membership itself is checked where the row is loaded.
 */
export function canTakePartIn(row: Pick<ThreadRow, "createdBy" | "shared">, userId: string): boolean {
  return startedBy(row, userId) || sharedWithWorkspace(row);
}

/**
 * Throws 403 unless the user may take part in the thread. The message says whether the
 * starter could still share it: someone no longer in the workspace cannot.
 */
export async function requireTakingPart(db: Db, row: Pick<ThreadRow, "createdBy" | "shared" | "workspaceId">, userId: string): Promise<void> {
  if (canTakePartIn(row, userId)) return;
  const starterIsHere = row.createdBy !== null && (await isWorkspaceMember(db, row.createdBy, row.workspaceId));
  throw new HttpError(403, starterIsHere ? ONLY_THE_STARTER : STARTER_HAS_LEFT);
}

/** The thread, for someone about to change it or reach its sandbox: 404 unless they are in its workspace, 403 unless they may take part. */
export async function getThreadToTakePart(db: Db, userId: string, threadId: string): Promise<ThreadRow> {
  const row = await getThreadForUser(db, userId, threadId);
  await requireTakingPart(db, row, userId);
  return row;
}

/** Threads in a workspace, newest activity first. 403 unless the user is a member. */
export async function listThreadsForUser(db: Db, userId: string, workspaceId: string, limit = 200): Promise<ThreadRow[]> {
  await requireWorkspaceMember(db, userId, workspaceId);
  return db.select().from(threads).where(eq(threads.workspaceId, workspaceId)).orderBy(desc(threads.updatedAt)).limit(limit);
}

// ─── Computers ───────────────────────────────────────────────────────────────

/** The computer, if it is the user's and they are still in its workspace; otherwise null. */
export async function findComputerForUser(db: Db, userId: string, computerId: string): Promise<ComputerRow | null> {
  const row = await db
    .select({ computer: computers })
    .from(computers)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, computers.workspaceId), eq(workspaceMembers.userId, userId)))
    .where(and(eq(computers.id, computerId), eq(computers.userId, userId)))
    .get();
  return row?.computer ?? null;
}

/** The user's own computers in a workspace. 403 unless the user is a member. */
export async function listComputersForUser(db: Db, userId: string, workspaceId: string): Promise<ComputerRow[]> {
  await requireWorkspaceMember(db, userId, workspaceId);
  return db
    .select()
    .from(computers)
    .where(and(eq(computers.userId, userId), eq(computers.workspaceId, workspaceId)))
    .orderBy(desc(computers.updatedAt));
}

// ─── Personal access tokens ──────────────────────────────────────────────────

export interface AccessTokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const tokenInfo = {
  id: accessTokens.id,
  name: accessTokens.name,
  createdAt: accessTokens.createdAt,
  lastUsedAt: accessTokens.lastUsedAt,
};

/** The user's tokens, newest first. Never their hashes. */
export function listAccessTokens(db: Db, userId: string): Promise<AccessTokenInfo[]> {
  return db.select(tokenInfo).from(accessTokens).where(eq(accessTokens.userId, userId)).orderBy(desc(accessTokens.createdAt));
}

export async function createAccessTokenRow(db: Db, userId: string, name: string, tokenHash: string): Promise<AccessTokenInfo> {
  const [row] = await db.insert(accessTokens).values({ userId, name, tokenHash }).returning(tokenInfo);
  return row!;
}

/** Delete one of the user's tokens. False if it does not exist or belongs to someone else. */
export async function revokeAccessToken(db: Db, userId: string, tokenId: string): Promise<boolean> {
  const deleted = await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.id, tokenId), eq(accessTokens.userId, userId)))
    .returning({ id: accessTokens.id });
  return deleted.length > 0;
}

/** A token nobody has used for this many days stops working. One that was never used counts from the day it was made. */
export const ACCESS_TOKEN_IDLE_DAYS = 90;
export const ACCESS_TOKEN_IDLE_MS = ACCESS_TOKEN_IDLE_DAYS * 24 * 60 * 60 * 1000;

/** How often a token's use is written down: far more often than the days above count in, without a write on every request. */
const RECORD_TOKEN_USE_EVERY_MS = 60 * 60 * 1000;

/** When a token was last used, or made if it never was. A date that can't be read counts as long ago. */
function tokenLastActive(row: { createdAt: string; lastUsedAt: string | null }): number {
  const at = Date.parse(row.lastUsedAt ?? row.createdAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * Who a token belongs to, by the SHA-256 of its raw value. Null for a token that doesn't
 * exist or has gone unused for too long. Records use at most once an hour.
 */
export async function findUserByTokenHash(db: Db, tokenHash: string, nowMs: number = Date.now()): Promise<string | null> {
  const row = await db
    .select({ id: accessTokens.id, userId: accessTokens.userId, createdAt: accessTokens.createdAt, lastUsedAt: accessTokens.lastUsedAt })
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, tokenHash))
    .get();
  if (!row) return null;
  const idleMs = nowMs - tokenLastActive(row);
  if (idleMs > ACCESS_TOKEN_IDLE_MS) return null;
  if (!row.lastUsedAt || idleMs > RECORD_TOKEN_USE_EVERY_MS) {
    try {
      await db
        .update(accessTokens)
        .set({ lastUsedAt: new Date(nowMs).toISOString() })
        .where(eq(accessTokens.id, row.id));
    } catch (err) {
      console.error("[lemonlime] could not record token use:", err);
    }
  }
  return row.userId;
}

/** Delete tokens that have gone unused for too long to work any more. Returns how many. For the scheduled sweep. */
export async function deleteIdleAccessTokens(db: Db, nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - ACCESS_TOKEN_IDLE_MS).toISOString();
  const deleted = await db
    .delete(accessTokens)
    .where(lt(sql`coalesce(${accessTokens.lastUsedAt}, ${accessTokens.createdAt})`, cutoff))
    .returning({ id: accessTokens.id });
  return deleted.length;
}
