import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { automations, threads, user, workspaceInvites, workspaceMembers, workspaces, type Db, type WorkspaceRole } from "@lemonlime/db";
import { userWorkspaceIds } from "./access.ts";
import type { AppContext } from "./context.ts";
import { inviteEmail } from "./email.ts";
import { HttpError, PolicyDeniedError } from "./errors.ts";

/**
 * Workspace members and email invitations. Owners invite people by email; the link in
 * the email can only be accepted by someone signed in with that address. The deployment's
 * usage policy (canAddMember) decides how many people a workspace may have.
 */

export const INVITE_TTL_DAYS = 7;
/** Invitations one workspace can have waiting at once. */
export const MAX_PENDING_INVITES = 50;

export interface WorkspaceSummary {
  id: string;
  name: string;
  personal: boolean;
  role: WorkspaceRole;
}

export interface MemberInfo {
  userId: string;
  email: string | null;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface InviteInfo {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The workspaces a user belongs to, personal one first (the same order as userWorkspaceIds). */
export async function listWorkspaces(db: Db, userId: string): Promise<WorkspaceSummary[]> {
  const ids = await userWorkspaceIds(db, userId);
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, personal: workspaces.personal, createdBy: workspaces.createdBy, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
  return ids.flatMap(id => {
    const r = rows.find(x => x.id === id);
    // Someone else's personal workspace is only "personal" to them.
    return r ? [{ id: r.id, name: r.name, personal: r.personal && r.createdBy === userId, role: r.role }] : [];
  });
}

export async function memberRole(db: Db, userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

/** Throws 403 unless the user is one of the workspace's owners. */
export async function requireOwner(db: Db, userId: string, workspaceId: string): Promise<void> {
  const role = await memberRole(db, userId, workspaceId);
  if (!role) throw new HttpError(403, "You are not a member of that workspace.");
  if (role !== "owner") throw new HttpError(403, "Only the workspace's owners can do that.");
}

const pending = (workspaceId: string, nowIso: string) =>
  and(eq(workspaceInvites.workspaceId, workspaceId), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, nowIso));

/** Members and invitations still waiting. Any member may look. */
export async function listMembers(db: Db, workspaceId: string, now = Date.now()): Promise<{ members: MemberInfo[]; invites: InviteInfo[] }> {
  const members = await db
    .select({ userId: workspaceMembers.userId, email: user.email, name: user.name, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
  const invites = await db
    .select({ id: workspaceInvites.id, email: workspaceInvites.email, createdAt: workspaceInvites.createdAt, expiresAt: workspaceInvites.expiresAt })
    .from(workspaceInvites)
    .where(pending(workspaceId, new Date(now).toISOString()))
    .orderBy(asc(workspaceInvites.createdAt));
  return { members, invites };
}

/** Ask the usage policy whether one more person may join. */
async function checkSeat(ctx: AppContext, userId: string, workspaceId: string, exceptInviteId?: string): Promise<void> {
  const policy = ctx.plugin.usagePolicy;
  if (!policy.canAddMember) return;
  const [{ members }] = (await ctx.db
    .select({ members: sql<number>`count(*)` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))) as [{ members: number }];
  const waiting = await ctx.db.select({ id: workspaceInvites.id }).from(workspaceInvites).where(pending(workspaceId, new Date().toISOString()));
  const pendingInvites = waiting.filter(i => i.id !== exceptInviteId).length;
  const decision = await policy.canAddMember({ userId, workspaceId, members: Number(members), pendingInvites });
  if (!decision.allow) throw new PolicyDeniedError(decision);
}

/**
 * Invite someone by email. Sending again to the same address replaces the earlier
 * invitation (its link stops working). Owners only.
 */
export async function inviteMember(ctx: AppContext, o: { userId: string; workspaceId: string; email: string }): Promise<InviteInfo> {
  await requireOwner(ctx.db, o.userId, o.workspaceId);
  const address = normalizeEmail(o.email);
  const [already] = await ctx.db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, o.workspaceId), sql`lower(${user.email}) = ${address}`));
  if (already) throw new HttpError(409, "That person is already in this workspace.");

  await ctx.db
    .delete(workspaceInvites)
    .where(and(eq(workspaceInvites.workspaceId, o.workspaceId), eq(workspaceInvites.email, address), isNull(workspaceInvites.acceptedAt)));
  const now = Date.now();
  const waiting = await ctx.db
    .select({ id: workspaceInvites.id })
    .from(workspaceInvites)
    .where(pending(o.workspaceId, new Date(now).toISOString()));
  if (waiting.length >= MAX_PENDING_INVITES) throw new HttpError(400, "Too many invitations are waiting. Withdraw some first.");
  await checkSeat(ctx, o.userId, o.workspaceId);

  const token = newToken();
  const invite = {
    id: crypto.randomUUID(),
    workspaceId: o.workspaceId,
    email: address,
    role: "member" as const,
    tokenHash: await sha256Hex(token),
    invitedBy: o.userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_DAYS * 86_400_000).toISOString(),
  };
  await ctx.db.insert(workspaceInvites).values(invite);

  const [ws] = await ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, o.workspaceId));
  const [inviter] = await ctx.db.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, o.userId));
  const who = inviter?.name || inviter?.email || "Someone";
  const link = new URL(`/invite/${token}`, ctx.config.publicUrl()).toString();
  try {
    await ctx.email.send(
      inviteEmail(ctx.config.emailBrand(), { to: address, inviter: who, workspace: ws?.name ?? "a LemonLime workspace", link, days: INVITE_TTL_DAYS }),
    );
  } catch (err) {
    await ctx.db.delete(workspaceInvites).where(eq(workspaceInvites.id, invite.id));
    console.error("[lemonlime] invite email failed:", err);
    throw new HttpError(502, "The invitation email couldn't be sent. Try again in a moment.");
  }
  return { id: invite.id, email: address, createdAt: invite.createdAt, expiresAt: invite.expiresAt };
}

export type InviteLookup =
  | { ok: true; inviteId: string; workspaceId: string; workspaceName: string; email: string; invitedBy: string | null }
  | { ok: false; reason: "not_found" | "used" | "expired" };

/** What an invitation link points at, for the accept page. */
export async function findInvite(db: Db, token: string, now = Date.now()): Promise<InviteLookup> {
  if (!token || token.length > 200) return { ok: false, reason: "not_found" };
  const [row] = await db
    .select({ invite: workspaceInvites, workspaceName: workspaces.name, inviterName: user.name, inviterEmail: user.email })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
    .leftJoin(user, eq(user.id, workspaceInvites.invitedBy))
    .where(eq(workspaceInvites.tokenHash, await sha256Hex(token)));
  if (!row) return { ok: false, reason: "not_found" };
  if (row.invite.acceptedAt) return { ok: false, reason: "used" };
  if (Date.parse(row.invite.expiresAt) <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    inviteId: row.invite.id,
    workspaceId: row.invite.workspaceId,
    workspaceName: row.workspaceName,
    email: row.invite.email,
    invitedBy: row.inviterName || row.inviterEmail || null,
  };
}

/** Join the workspace an invitation is for. Returns its id. */
export async function acceptInvite(ctx: AppContext, o: { userId: string; token: string }): Promise<string> {
  const found = await findInvite(ctx.db, o.token);
  if (!found.ok) {
    if (found.reason === "expired") throw new HttpError(410, "This invitation has expired. Ask for a new one.");
    if (found.reason === "used") throw new HttpError(410, "This invitation has already been used.");
    throw new HttpError(404, "This invitation doesn't exist or was withdrawn.");
  }
  const [me] = await ctx.db.select({ email: user.email, emailVerified: user.emailVerified }).from(user).where(eq(user.id, o.userId));
  if (!me?.email || normalizeEmail(me.email) !== found.email)
    throw new HttpError(403, "This invitation was sent to a different email address. Sign in with that address to accept it.");
  // An account can carry an address nobody has shown they own. The invitation is for whoever reads that inbox.
  if (!me.emailVerified) throw new HttpError(403, "Confirm your email address first: sign out, then sign in with a code sent to it.");
  if (!(await memberRole(ctx.db, o.userId, found.workspaceId))) {
    await checkSeat(ctx, o.userId, found.workspaceId, found.inviteId);
    await ctx.db.insert(workspaceMembers).values({ workspaceId: found.workspaceId, userId: o.userId, role: "member" }).onConflictDoNothing();
  }
  await ctx.db.update(workspaceInvites).set({ acceptedAt: new Date().toISOString() }).where(eq(workspaceInvites.id, found.inviteId));
  return found.workspaceId;
}

/** Why an automation stopped when the person it runs as left its workspace. */
export const AUTOMATION_CREATOR_LEFT = "The person who set this up is no longer in this workspace.";

/**
 * Remove someone from a workspace. Owners can remove members; anyone can leave. A
 * workspace always keeps an owner, and nobody leaves their own personal workspace.
 * Automations they set up there are switched off: those run as them. Threads they started
 * stay readable but stop being shared, so nobody else directs them from then on.
 */
export async function removeMember(ctx: AppContext, o: { userId: string; workspaceId: string; memberId: string }): Promise<void> {
  const myRole = await memberRole(ctx.db, o.userId, o.workspaceId);
  if (!myRole) throw new HttpError(403, "You are not a member of that workspace.");
  const leaving = o.memberId === o.userId;
  if (!leaving && myRole !== "owner") throw new HttpError(403, "Only the workspace's owners can remove people.");
  const theirRole = await memberRole(ctx.db, o.memberId, o.workspaceId);
  if (!theirRole) throw new HttpError(404, "That person isn't in this workspace.");
  if (!leaving && theirRole === "owner") throw new HttpError(403, "Owners can't remove other owners.");
  const [ws] = await ctx.db.select({ personal: workspaces.personal, createdBy: workspaces.createdBy }).from(workspaces).where(eq(workspaces.id, o.workspaceId));
  if (ws?.personal && ws.createdBy === o.memberId) throw new HttpError(400, "Nobody can leave their own personal workspace.");
  if (theirRole === "owner") {
    const owners = await ctx.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, o.workspaceId), eq(workspaceMembers.role, "owner")));
    if (owners.length <= 1) throw new HttpError(400, "A workspace needs at least one owner.");
  }
  await ctx.db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, o.workspaceId), eq(workspaceMembers.userId, o.memberId)));
  await ctx.db
    .update(automations)
    .set({ enabled: false, nextRunAt: null, pausedReason: AUTOMATION_CREATOR_LEFT })
    .where(and(eq(automations.workspaceId, o.workspaceId), eq(automations.createdBy, o.memberId), eq(automations.enabled, true)));
  // Threads they shared ran with their agent sign-in: the rest of the workspace can still
  // read them, but no longer directs them. Their place in the thread list stays the same.
  await ctx.db
    .update(threads)
    .set({ shared: false, updatedAt: sql`${threads.updatedAt}` })
    .where(and(eq(threads.workspaceId, o.workspaceId), eq(threads.createdBy, o.memberId), eq(threads.shared, true)));
}

/** Withdraw an invitation that hasn't been accepted. Owners only. */
export async function revokeInvite(ctx: AppContext, o: { userId: string; workspaceId: string; inviteId: string }): Promise<boolean> {
  await requireOwner(ctx.db, o.userId, o.workspaceId);
  const gone = await ctx.db
    .delete(workspaceInvites)
    .where(and(eq(workspaceInvites.id, o.inviteId), eq(workspaceInvites.workspaceId, o.workspaceId), isNull(workspaceInvites.acceptedAt)))
    .returning({ id: workspaceInvites.id });
  return gone.length > 0;
}
