import { and, desc, eq, inArray } from "drizzle-orm";
import {
  accessTokens,
  account,
  agentCredentials,
  automations,
  computers,
  githubInstallations,
  secrets,
  session,
  threads,
  user,
  workspaceMembers,
  workspaceSettings,
  workspaces,
  type ThreadRow,
} from "@lemonlime/db";
import type { ThreadEvent } from "@lemonlime/protocol";
import type { AppContext } from "./context.ts";
import { HttpError } from "./errors.ts";
import { deleteHistory, readHistory } from "./history.ts";
import { getThreadForUser } from "./access.ts";
import { listMembers, listWorkspaces, memberRole, requireOwner } from "./members.ts";
import { endRun } from "./threads.ts";

/**
 * Deleting and exporting people's data, from Settings. Deletion is real: sandboxes are
 * destroyed, stored history is removed and the rows go (the database cascades the rest).
 */

/** Destroy a thread's sandbox and delete its stored history and its row. */
export async function purgeThread(ctx: AppContext, row: ThreadRow): Promise<void> {
  if (row.sandboxId) await endRun(ctx, row, "user", { destroy: true });
  await deleteHistory(ctx, row.id);
  await ctx.db.delete(threads).where(eq(threads.id, row.id));
}

/**
 * Delete a thread for good: its sandbox, stored history and row. The person who started it
 * or a workspace owner may.
 */
export async function deleteThreadForever(ctx: AppContext, userId: string, threadId: string): Promise<void> {
  const row = await getThreadForUser(ctx.db, userId, threadId);
  if (row.createdBy !== userId && (await memberRole(ctx.db, userId, row.workspaceId)) !== "owner") {
    throw new HttpError(403, "Only the person who started this thread or a workspace owner can delete it.");
  }
  await purgeThread(ctx, row);
}

async function purgeWorkspace(ctx: AppContext, workspaceId: string, deletedBy: string): Promise<void> {
  const rows = await ctx.db.select().from(threads).where(eq(threads.workspaceId, workspaceId));
  // Sandboxes first: once the row is gone nothing would ever stop them.
  for (const row of rows) if (row.sandboxId) await endRun(ctx, row, "user", { destroy: true });
  await ctx.plugin.events.onWorkspaceDeleted?.({ workspaceId, deletedBy });
  for (const row of rows) await deleteHistory(ctx, row.id);
  await ctx.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

/** What deleting a workspace or an account would take with it, for the confirmation. */
export interface DeletionPreview {
  /** Workspaces deleted with the account: ones only this person owns. */
  workspaces: { id: string; name: string; personal: boolean; otherMembers: number; threads: number }[];
  /** Team workspaces this person only leaves. */
  leaves: { id: string; name: string }[];
}

async function ownersOf(ctx: AppContext, workspaceId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")));
  return rows.map(r => r.userId);
}

export async function deletionPreview(ctx: AppContext, userId: string): Promise<DeletionPreview> {
  const preview: DeletionPreview = { workspaces: [], leaves: [] };
  for (const w of await listWorkspaces(ctx.db, userId)) {
    const soleOwner = w.role === "owner" && (await ownersOf(ctx, w.id)).every(id => id === userId);
    if (!soleOwner) {
      preview.leaves.push({ id: w.id, name: w.name });
      continue;
    }
    const { members } = await listMembers(ctx.db, w.id);
    const threadCount = (await ctx.db.select({ id: threads.id }).from(threads).where(eq(threads.workspaceId, w.id))).length;
    preview.workspaces.push({
      id: w.id,
      name: w.name,
      personal: w.personal,
      otherMembers: members.filter(m => m.userId !== userId).length,
      threads: threadCount,
    });
  }
  return preview;
}

/** Delete a team workspace and everything in it. Owners only; a personal workspace goes with its account. */
export async function deleteWorkspace(ctx: AppContext, userId: string, workspaceId: string): Promise<void> {
  await requireOwner(ctx.db, userId, workspaceId);
  const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new HttpError(404, "No such workspace.");
  if (ws.personal) throw new HttpError(400, "A personal workspace is deleted with its owner's account.");
  await purgeWorkspace(ctx, workspaceId, userId);
  console.log(`[account] ${userId} deleted workspace ${workspaceId}`);
}

/**
 * Delete an account: every workspace only this person owns (with its threads, sandboxes,
 * history, secrets and automations), their place in other workspaces, and the account
 * itself with its sign-ins, sessions, tokens and computers. Threads they started in a team
 * workspace that lives on stay with that team.
 */
export async function deleteAccount(ctx: AppContext, userId: string): Promise<void> {
  const [me] = await ctx.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!me) throw new HttpError(404, "No such account.");
  const preview = await deletionPreview(ctx, userId);
  for (const w of preview.workspaces) await purgeWorkspace(ctx, w.id, userId);
  await ctx.plugin.events.onUserDeleted?.({ userId, email: me.email });
  await ctx.db.delete(user).where(eq(user.id, userId));
  console.log(`[account] deleted account ${userId} and ${preview.workspaces.length} workspace(s)`);
}

/** The most threads, and stored history, one export carries. */
export const EXPORT_LIMITS = { threads: 1000, historyBytes: 50 * 1024 * 1024 } as const;

/**
 * Everything kept about this person, as one JSON document: their account, sign-in methods
 * (never tokens), sessions, workspaces with their settings, secret names (never values),
 * automations, and the threads they started with their full stored history.
 */
export async function exportAccount(ctx: AppContext, userId: string): Promise<Record<string, unknown>> {
  const [me] = await ctx.db.select().from(user).where(eq(user.id, userId));
  if (!me) throw new HttpError(404, "No such account.");
  const mine = await listWorkspaces(ctx.db, userId);
  const ids = mine.map(w => w.id);

  const signIns = await ctx.db
    .select({ provider: account.providerId, accountId: account.accountId, createdAt: account.createdAt })
    .from(account)
    .where(eq(account.userId, userId));
  const sessions = await ctx.db
    .select({ createdAt: session.createdAt, expiresAt: session.expiresAt, ipAddress: session.ipAddress, userAgent: session.userAgent })
    .from(session)
    .where(eq(session.userId, userId));
  const tokens = await ctx.db
    .select({ name: accessTokens.name, createdAt: accessTokens.createdAt, lastUsedAt: accessTokens.lastUsedAt })
    .from(accessTokens)
    .where(eq(accessTokens.userId, userId));
  const myComputers = await ctx.db
    .select({
      name: computers.name,
      platform: computers.platform,
      phoneAccess: computers.phoneAccess,
      lastSeenAt: computers.lastSeenAt,
      createdAt: computers.createdAt,
    })
    .from(computers)
    .where(eq(computers.userId, userId));
  const savedSignIns = await ctx.db
    .select({ agent: agentCredentials.agent, kind: agentCredentials.kind, name: agentCredentials.name, updatedAt: agentCredentials.updatedAt })
    .from(agentCredentials)
    .where(eq(agentCredentials.userId, userId));

  const workspaceData = [];
  for (const w of mine) {
    const [settings] = await ctx.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, w.id));
    const secretNames = await ctx.db.select({ name: secrets.name, createdAt: secrets.createdAt }).from(secrets).where(eq(secrets.workspaceId, w.id));
    const autos = await ctx.db.select().from(automations).where(eq(automations.workspaceId, w.id));
    const repos = await ctx.db
      .select({ account: githubInstallations.accountLogin, createdAt: githubInstallations.createdAt })
      .from(githubInstallations)
      .where(eq(githubInstallations.workspaceId, w.id));
    const { members } = await listMembers(ctx.db, w.id);
    workspaceData.push({
      ...w,
      members: members.map(m => ({ email: m.email, role: m.role, joinedAt: m.joinedAt })),
      settings: settings ?? null,
      secrets: secretNames,
      automations: autos.map(({ webhookTokenHash: _hash, ...a }) => a),
      githubAccounts: repos,
    });
  }

  // Threads they started, newest first, with what the control plane stored of each.
  const started = ids.length
    ? await ctx.db
        .select()
        .from(threads)
        .where(and(inArray(threads.workspaceId, ids), eq(threads.createdBy, userId)))
        .orderBy(desc(threads.createdAt))
        .limit(EXPORT_LIMITS.threads + 1)
    : [];
  let bytes = 0;
  let historyCut = false;
  const threadData = [];
  for (const t of started.slice(0, EXPORT_LIMITS.threads)) {
    const events: ThreadEvent[] = [];
    if (!historyCut) {
      let after = 0;
      for (;;) {
        const page = await readHistory(ctx, t.id, after);
        events.push(...page.events);
        bytes += JSON.stringify(page.events).length;
        if (bytes > EXPORT_LIMITS.historyBytes) {
          historyCut = true;
          break;
        }
        if (!page.more || page.events.length === 0) break;
        after = page.events.at(-1)!.seq;
      }
    }
    const { runnerUrl: _url, sandboxId: _sandbox, ...meta } = t;
    threadData.push({ ...meta, history: events });
  }

  const extra = (await ctx.plugin.events.exportUserData?.({ userId, email: me.email, workspaceIds: ids })) ?? null;
  return {
    exportedAt: new Date().toISOString(),
    note: "Everything LemonLime keeps about you. Sign-in tokens and secret values are never stored readable, so they aren't here.",
    account: { id: me.id, name: me.name, email: me.email, emailVerified: me.emailVerified, createdAt: me.createdAt },
    signIns,
    sessions,
    accessTokens: tokens,
    computers: myComputers,
    savedAgentSignIns: savedSignIns,
    workspaces: workspaceData,
    threads: threadData,
    ...(started.length > EXPORT_LIMITS.threads || historyCut
      ? { incomplete: "This export hit its size limit. Ask the people who run this service for a full copy." }
      : {}),
    ...(extra ? { deployment: extra } : {}),
  };
}
