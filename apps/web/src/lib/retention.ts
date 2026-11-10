import { and, isNotNull, lt, or } from "drizzle-orm";
import { desktopApprovals, rateLimit, session, verification, workspaceInvites } from "@lemonlime/db";
import { deleteIdleAccessTokens } from "./access.ts";
import type { AppContext } from "./context.ts";

/**
 * How long short-lived records are kept once they're no use. The sweep removes them, so
 * nothing (IP addresses, browser details, invite emails) lingers longer than it must.
 */
export const RETENTION = {
  /** Rate-limit counters: the longest window is an hour; a day leaves room. */
  rateLimitMs: 24 * 60 * 60 * 1000,
  /** Invitations, once accepted or expired. */
  inviteMs: 30 * 24 * 60 * 60 * 1000,
  /** Notes of used desktop sign-in links: the app gives up on a link long before a day is out. */
  desktopApprovalMs: 24 * 60 * 60 * 1000,
} as const;

export interface Pruned {
  sessions: number;
  verifications: number;
  rateLimits: number;
  invites: number;
  desktopApprovals: number;
  accessTokens: number;
}

/**
 * Delete expired sessions and sign-in codes, stale rate-limit counters, old invitations, old
 * notes of used desktop sign-in links, and access tokens left unused too long to work.
 */
export async function pruneOldRecords(ctx: AppContext, now = Date.now()): Promise<Pruned> {
  const at = new Date(now);
  const sessions = await ctx.db.delete(session).where(lt(session.expiresAt, at)).returning({ id: session.id });
  const verifications = await ctx.db.delete(verification).where(lt(verification.expiresAt, at)).returning({ id: verification.id });
  // Better Auth's own counters and ours share this table, both in milliseconds.
  const rateLimits = await ctx.db
    .delete(rateLimit)
    .where(lt(rateLimit.lastRequest, now - RETENTION.rateLimitMs))
    .returning({ id: rateLimit.id });
  const inviteCutoff = new Date(now - RETENTION.inviteMs).toISOString();
  const invites = await ctx.db
    .delete(workspaceInvites)
    .where(or(lt(workspaceInvites.expiresAt, inviteCutoff), and(isNotNull(workspaceInvites.acceptedAt), lt(workspaceInvites.acceptedAt, inviteCutoff))))
    .returning({ id: workspaceInvites.id });
  const approvals = await ctx.db
    .delete(desktopApprovals)
    .where(lt(desktopApprovals.createdAt, new Date(now - RETENTION.desktopApprovalMs).toISOString()))
    .returning({ stateHash: desktopApprovals.stateHash });
  return {
    sessions: sessions.length,
    verifications: verifications.length,
    rateLimits: rateLimits.length,
    invites: invites.length,
    desktopApprovals: approvals.length,
    accessTokens: await deleteIdleAccessTokens(ctx.db, now),
  };
}
