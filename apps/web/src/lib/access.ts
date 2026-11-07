import { and, asc, desc, eq, sql } from "drizzle-orm";
import { accessTokens, threads, workspaceMembers, workspaces, type Db, type ThreadRow } from "@lemonlime/db";
import { HttpError } from "./errors.ts";

/**
 * Authorization. SQLite has no row-level security, so every read or write a
 * user makes goes through this module, which checks that the user belongs to
 * the workspace (threads) or owns the row (access tokens).
 *
 * Rules:
 * - A user sees and changes threads only in workspaces they are a member of.
 *   Threads in other workspaces are reported as "not found", never "forbidden",
 *   so ids do not leak.
 * - Asking for a workspace you are not in is a 403.
 * - Access tokens belong to one user; only that user can list or revoke them.
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

/** Threads in a workspace, newest activity first. 403 unless the user is a member. */
export async function listThreadsForUser(db: Db, userId: string, workspaceId: string, limit = 200): Promise<ThreadRow[]> {
  await requireWorkspaceMember(db, userId, workspaceId);
  return db.select().from(threads).where(eq(threads.workspaceId, workspaceId)).orderBy(desc(threads.updatedAt)).limit(limit);
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

/** Who a token belongs to, by the SHA-256 of its raw value. Records use at most once a minute. */
export async function findUserByTokenHash(db: Db, tokenHash: string, nowMs: number = Date.now()): Promise<string | null> {
  const row = await db
    .select({ id: accessTokens.id, userId: accessTokens.userId, lastUsedAt: accessTokens.lastUsedAt })
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, tokenHash))
    .get();
  if (!row) return null;
  const last = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
  if (nowMs - last > 60_000) {
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
