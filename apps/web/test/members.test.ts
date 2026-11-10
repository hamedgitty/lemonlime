import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { user, workspaceInvites } from "@lemonlime/db";
import { requestWorkspace, WORKSPACE_COOKIE } from "../src/lib/current-workspace.ts";
import { acceptInvite, findInvite, inviteMember, listMembers, listWorkspaces, removeMember, revokeInvite } from "../src/lib/members.ts";
import { addUser, createTestApp } from "./helpers.ts";

/** The token from the link in the last invitation email. */
const tokenFrom = (text: string) => /\/invite\/([A-Za-z0-9_-]+)/.exec(text)![1]!;

describe("workspace members", () => {
  it("invites by email, and only that address can accept, once", async () => {
    const { ctx, db, emails } = await createTestApp();
    const owner = await addUser(db, "owner@example.com");
    const bob = await addUser(db, "Bob@Example.com");
    const eve = await addUser(db, "eve@example.com");

    const invite = await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: " BOB@example.com " });
    expect(invite.email).toBe("bob@example.com");
    expect(emails.at(-1)).toMatchObject({ to: "bob@example.com" });
    const token = tokenFrom(emails.at(-1)!.text);
    expect(emails.at(-1)!.html).toContain(`/invite/${token}`);
    // Only a hash is stored.
    const [row] = await db.select().from(workspaceInvites);
    expect(row!.tokenHash).not.toContain(token);

    await expect(acceptInvite(ctx, { userId: eve.userId, token })).rejects.toMatchObject({ status: 403 });
    expect(await acceptInvite(ctx, { userId: bob.userId, token })).toBe(owner.workspaceId);
    await expect(acceptInvite(ctx, { userId: bob.userId, token })).rejects.toMatchObject({ status: 410 });
    expect(await findInvite(db, token)).toEqual({ ok: false, reason: "used" });

    const { members, invites } = await listMembers(db, owner.workspaceId);
    expect(members.map(m => [m.email, m.role])).toEqual([
      ["owner@example.com", "owner"],
      ["Bob@Example.com", "member"],
    ]);
    expect(invites).toEqual([]);
    // Bob now has two workspaces: his own first, then the team's.
    expect((await listWorkspaces(db, bob.userId)).map(w => [w.id, w.personal, w.role])).toEqual([
      [bob.workspaceId, true, "owner"],
      [owner.workspaceId, false, "member"],
    ]);
  });

  it("waits until the invited address is confirmed", async () => {
    const { ctx, db, emails } = await createTestApp();
    const owner = await addUser(db, "owner@example.com");
    const bob = await addUser(db, "bob@example.com");
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, bob.userId));
    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    const token = tokenFrom(emails.at(-1)!.text);

    await expect(acceptInvite(ctx, { userId: bob.userId, token })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Confirm your email"),
    });
    expect((await listMembers(db, owner.workspaceId)).members).toHaveLength(1);

    await db.update(user).set({ emailVerified: true }).where(eq(user.id, bob.userId));
    expect(await acceptInvite(ctx, { userId: bob.userId, token })).toBe(owner.workspaceId);
  });

  it("refuses unknown, withdrawn and expired links, and replaces an earlier invite to the same address", async () => {
    const { ctx, db, emails } = await createTestApp();
    const owner = await addUser(db, "owner@example.com");
    const bob = await addUser(db, "bob@example.com");
    await expect(acceptInvite(ctx, { userId: bob.userId, token: "nope" })).rejects.toMatchObject({ status: 404 });

    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    const first = tokenFrom(emails.at(-1)!.text);
    const again = await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    expect(await findInvite(db, first)).toEqual({ ok: false, reason: "not_found" });
    expect((await listMembers(db, owner.workspaceId)).invites).toHaveLength(1);

    expect(await revokeInvite(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, inviteId: again.id })).toBe(true);
    await expect(acceptInvite(ctx, { userId: bob.userId, token: tokenFrom(emails.at(-1)!.text) })).rejects.toMatchObject({ status: 404 });

    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    const late = tokenFrom(emails.at(-1)!.text);
    await db.update(workspaceInvites).set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(acceptInvite(ctx, { userId: bob.userId, token: late })).rejects.toMatchObject({ status: 410 });
  });

  it("lets only owners invite and remove, and keeps people in their own workspace", async () => {
    const { ctx, db, emails } = await createTestApp();
    const owner = await addUser(db, "owner@example.com");
    const bob = await addUser(db, "bob@example.com");
    const carol = await addUser(db, "carol@example.com");
    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    await acceptInvite(ctx, { userId: bob.userId, token: tokenFrom(emails.at(-1)!.text) });

    await expect(inviteMember(ctx, { userId: bob.userId, workspaceId: owner.workspaceId, email: "x@example.com" })).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(ctx, { userId: carol.userId, workspaceId: owner.workspaceId, email: "x@example.com" })).rejects.toMatchObject({ status: 403 });
    await expect(inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" })).rejects.toMatchObject({ status: 409 });
    await expect(removeMember(ctx, { userId: bob.userId, workspaceId: owner.workspaceId, memberId: owner.userId })).rejects.toMatchObject({ status: 403 });
    await expect(removeMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, memberId: owner.userId })).rejects.toMatchObject({ status: 400 });

    await removeMember(ctx, { userId: bob.userId, workspaceId: owner.workspaceId, memberId: bob.userId });
    expect((await listMembers(db, owner.workspaceId)).members).toHaveLength(1);
  });

  it("asks the usage policy before inviting and again before joining", async () => {
    const seen: unknown[] = [];
    let seats = 2;
    const { ctx, db, emails } = await createTestApp({
      policy: {
        async canAddMember(req) {
          seen.push(req);
          return req.members + req.pendingInvites < seats ? { allow: true } : { allow: false, reason: "Your plan has no more seats." };
        },
      },
    });
    const owner = await addUser(db, "owner@example.com");
    const bob = await addUser(db, "bob@example.com");
    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    expect(seen.at(-1)).toEqual({ userId: owner.userId, workspaceId: owner.workspaceId, members: 1, pendingInvites: 0 });
    await expect(inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "carol@example.com" })).rejects.toMatchObject({
      status: 402,
      body: { reason: "Your plan has no more seats." },
    });
    expect(emails).toHaveLength(1);

    // Bob's own pending invite doesn't count against him when he joins…
    await acceptInvite(ctx, { userId: bob.userId, token: tokenFrom(emails.at(-1)!.text) });
    expect(seen.at(-1)).toMatchObject({ members: 1, pendingInvites: 0 });
    // …but a plan that shrank in the meantime is checked at that moment.
    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "dan@example.com" }).catch(() => undefined);
    seats = 3;
    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "dan@example.com" });
    seats = 1;
    const dan = await addUser(db, "dan@example.com");
    await expect(acceptInvite(ctx, { userId: dan.userId, token: tokenFrom(emails.at(-1)!.text) })).rejects.toMatchObject({ status: 402 });
  });

  it("follows the saved workspace choice, unless it no longer applies", async () => {
    const { ctx, db, emails } = await createTestApp();
    const owner = await addUser(db, "owner@example.com");
    const bob = await addUser(db, "bob@example.com");
    await inviteMember(ctx, { userId: owner.userId, workspaceId: owner.workspaceId, email: "bob@example.com" });
    await acceptInvite(ctx, { userId: bob.userId, token: tokenFrom(emails.at(-1)!.text) });

    const req = (cookie?: string, query = "") =>
      new Request(`http://localhost/api/threads${query}`, { headers: cookie ? { cookie: `${WORKSPACE_COOKIE}=${cookie}` } : {} });
    expect(await requestWorkspace(db, bob.userId, req())).toBe(bob.workspaceId);
    expect(await requestWorkspace(db, bob.userId, req(owner.workspaceId))).toBe(owner.workspaceId);
    // An explicit ?workspace= still wins, and still refuses workspaces you're not in.
    expect(await requestWorkspace(db, bob.userId, req(owner.workspaceId, `?workspace=${bob.workspaceId}`))).toBe(bob.workspaceId);
    const carol = await addUser(db, "carol@example.com");
    await expect(requestWorkspace(db, bob.userId, req(undefined, `?workspace=${carol.workspaceId}`))).rejects.toMatchObject({ status: 403 });
    // A cookie for a workspace you've left falls back quietly instead of locking you out.
    await removeMember(ctx, { userId: bob.userId, workspaceId: owner.workspaceId, memberId: bob.userId });
    expect(await requestWorkspace(db, bob.userId, req(owner.workspaceId))).toBe(bob.workspaceId);
    // So does a cookie that got damaged.
    expect(await requestWorkspace(db, bob.userId, req("%E0%A4%A"))).toBe(bob.workspaceId);
    expect(await db.select().from(workspaceInvites).where(eq(workspaceInvites.email, "bob@example.com"))).toHaveLength(1);
  });
});
