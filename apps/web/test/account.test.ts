import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accessTokens,
  account,
  desktopApprovals,
  rateLimit,
  secrets,
  session,
  threads,
  user,
  verification,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "@lemonlime/db";
import type { CreateThreadRequest, ThreadEvent } from "@lemonlime/protocol";
import { ACCESS_TOKEN_IDLE_MS } from "../src/lib/access.ts";
import { deleteAccount, deleteThreadForever, deleteWorkspace, deletionPreview, exportAccount } from "../src/lib/account.ts";
import { appendHistory } from "../src/lib/history.ts";
import { acceptInvite, inviteMember } from "../src/lib/members.ts";
import { pruneOldRecords, RETENTION } from "../src/lib/retention.ts";
import { deleteSecret, setSecret } from "../src/lib/secrets.ts";
import { createThread, getThreadRow } from "../src/lib/threads.ts";
import { addUser, createTestApp } from "./helpers.ts";

const cloud: CreateThreadRequest = {
  agent: { kind: "claude-code" },
  repo: { url: "https://github.com/example/app.git", baseBranch: "main" },
  mode: "cloud",
  sandboxSize: "small",
};

const events = (threadId: string, n: number): ThreadEvent[] =>
  Array.from(
    { length: n },
    (_, i) => ({ threadId, seq: i + 1, at: "2026-01-01T00:00:00.000Z", type: "agent_message", text: `m${i + 1}`, partial: false }) as ThreadEvent,
  );

/** A thread with a running sandbox and some stored history. */
async function threadWithHistory(app: Awaited<ReturnType<typeof createTestApp>>, userId: string, workspaceId: string) {
  const created = await createThread(app.ctx, userId, workspaceId, cloud);
  const row = (await getThreadRow(app.ctx, created.thread.id))!;
  await appendHistory(app.ctx, row, events(row.id, 3));
  return (await getThreadRow(app.ctx, created.thread.id))!;
}

/** A team workspace owned by `owner` with `member` in it. */
async function team(app: Awaited<ReturnType<typeof createTestApp>>, owner: { userId: string }, member: { userId: string }, memberEmail: string) {
  const id = `ws-${crypto.randomUUID()}`;
  await app.db.insert(workspaces).values({ id, name: "Acme", personal: false, createdBy: owner.userId });
  await app.db.insert(workspaceMembers).values({ workspaceId: id, userId: owner.userId, role: "owner" });
  await inviteMember(app.ctx, { userId: owner.userId, workspaceId: id, email: memberEmail });
  const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(app.emails.at(-1)!.text)![1]!;
  await acceptInvite(app.ctx, { userId: member.userId, token });
  return id;
}

describe("deleting a thread for good", () => {
  it("destroys its sandbox and removes its stored history and row; only its starter or an owner may", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    const teamId = await team(app, alice, bob, "bob@example.com");
    const row = await threadWithHistory(app, alice.userId, teamId);
    expect(app.history.objects.size).toBe(1);

    await expect(deleteThreadForever(app.ctx, bob.userId, row.id)).rejects.toMatchObject({ status: 403 });
    await deleteThreadForever(app.ctx, alice.userId, row.id);
    expect(app.sandbox.calls).toContain(`destroy:${row.sandboxId}`);
    expect(app.history.objects.size).toBe(0);
    expect(await app.db.select().from(threads).where(eq(threads.id, row.id))).toEqual([]);

    // A workspace owner may delete a member's thread.
    const bobs = await threadWithHistory(app, bob.userId, teamId);
    await deleteThreadForever(app.ctx, alice.userId, bobs.id);
    expect(app.history.objects.size).toBe(0);
  });
});

describe("deleting an account", () => {
  it("takes the workspaces only they own with everything in them, and leaves teams they're only in", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    const teamId = await team(app, alice, bob, "bob@example.com");
    const personal = await threadWithHistory(app, alice.userId, alice.workspaceId);
    const inTeam = await threadWithHistory(app, alice.userId, teamId);
    const bobsInTeam = await threadWithHistory(app, bob.userId, teamId);
    await setSecret(app.ctx, alice.userId, alice.workspaceId, "NPM_TOKEN", "npm_value");
    await app.db.insert(account).values({ id: "acc1", accountId: "1", providerId: "github", userId: alice.userId, updatedAt: new Date() });
    await app.db.insert(session).values({ id: "s1", token: "tok", userId: alice.userId, expiresAt: new Date(Date.now() + 3600_000), updatedAt: new Date() });

    // Bob is a member of Alice's team: deleting Bob leaves the team (and his thread) in place.
    const bobPreview = await deletionPreview(app.ctx, bob.userId);
    expect(bobPreview.workspaces.map(w => w.id)).toEqual([bob.workspaceId]);
    expect(bobPreview.leaves.map(w => w.id)).toEqual([teamId]);

    // Alice owns both: the preview says what goes, including Bob's access.
    const preview = await deletionPreview(app.ctx, alice.userId);
    expect(preview.workspaces.map(w => [w.id, w.otherMembers, w.threads])).toEqual([
      [alice.workspaceId, 0, 1],
      [teamId, 1, 2],
    ]);

    const deleted: string[] = [];
    app.ctx.plugin.events.onWorkspaceDeleted = async w => void deleted.push(`ws:${w.workspaceId}`);
    app.ctx.plugin.events.onUserDeleted = async u => void deleted.push(`user:${u.email}`);
    await deleteAccount(app.ctx, alice.userId);

    expect(deleted).toEqual([`ws:${alice.workspaceId}`, `ws:${teamId}`, "user:alice@example.com"]);
    for (const t of [personal, inTeam, bobsInTeam]) expect(app.sandbox.calls).toContain(`destroy:${t.sandboxId}`);
    expect(app.history.objects.size).toBe(0);
    for (const table of [user, account, session, secrets, threads] as const) {
      const rows = await app.db.select().from(table);
      expect(rows.filter(r => JSON.stringify(r).includes(alice.userId) || JSON.stringify(r).includes(alice.workspaceId))).toEqual([]);
    }
    expect((await app.db.select().from(workspaces)).map(w => w.id)).toEqual([bob.workspaceId]);
  });

  it("stops when the deployment can't let a workspace go, leaving everything in place", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    app.ctx.plugin.events.onWorkspaceDeleted = async () => {
      throw new Error("couldn't end the subscription");
    };
    await expect(deleteAccount(app.ctx, alice.userId)).rejects.toThrow("subscription");
    expect(await app.db.select().from(user).where(eq(user.id, alice.userId))).toHaveLength(1);
  });

  it("only lets owners delete a team workspace, and never a personal one on its own", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    const teamId = await team(app, alice, bob, "bob@example.com");
    await expect(deleteWorkspace(app.ctx, bob.userId, teamId)).rejects.toMatchObject({ status: 403 });
    await expect(deleteWorkspace(app.ctx, alice.userId, alice.workspaceId)).rejects.toMatchObject({ status: 400 });
    await deleteWorkspace(app.ctx, alice.userId, teamId);
    expect(await app.db.select().from(workspaces).where(eq(workspaces.id, teamId))).toEqual([]);
  });
});

describe("exporting your data", () => {
  it("includes the account, workspaces, secret names and thread history, but never tokens or secret values", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const row = await threadWithHistory(app, alice.userId, alice.workspaceId);
    await setSecret(app.ctx, alice.userId, alice.workspaceId, "NPM_TOKEN", "npm_secret_value");
    await app.db.insert(account).values({ id: "acc1", accountId: "1", providerId: "github", userId: alice.userId, updatedAt: new Date() });
    await app.db.insert(session).values({
      id: "s1",
      token: "session_tok_value",
      userId: alice.userId,
      ipAddress: "203.0.113.9",
      expiresAt: new Date(Date.now() + 3600_000),
      updatedAt: new Date(),
    });
    app.ctx.plugin.events.exportUserData = async () => ({ invoices: 2 });

    const data = await exportAccount(app.ctx, alice.userId);
    const text = JSON.stringify(data);
    expect(data).toMatchObject({
      account: { email: "alice@example.com" },
      signIns: [{ provider: "github" }],
      sessions: [{ ipAddress: "203.0.113.9" }],
      deployment: { invoices: 2 },
    });
    expect((data.workspaces as { secrets: { name: string }[] }[])[0]!.secrets.map(s => s.name)).toEqual(["NPM_TOKEN"]);
    const exported = (data.threads as { id: string; history: ThreadEvent[] }[])[0]!;
    expect(exported.id).toBe(row.id);
    expect(exported.history.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(text).not.toContain("npm_secret_value");
    expect(text).not.toContain("session_tok_value");
    expect(text).not.toContain("runnerUrl");
  });
});

describe("workspace secrets", () => {
  it("can only be changed by owners", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    const teamId = await team(app, alice, bob, "bob@example.com");
    await expect(setSecret(app.ctx, bob.userId, teamId, "NPM_TOKEN", "x")).rejects.toMatchObject({ status: 403 });
    await setSecret(app.ctx, alice.userId, teamId, "NPM_TOKEN", "x");
    await expect(deleteSecret(app.ctx, bob.userId, teamId, "NPM_TOKEN")).rejects.toMatchObject({ status: 403 });
    expect(await deleteSecret(app.ctx, alice.userId, teamId, "NPM_TOKEN")).toBe(true);
  });
});

describe("cleaning up old records", () => {
  it("removes expired sessions and codes, stale counters, old invitations, used desktop links and long-unused tokens, and keeps the rest", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const now = Date.now();
    const past = new Date(now - 1000);
    const future = new Date(now + 3600_000);
    await app.db.insert(session).values([
      { id: "old", token: "a", userId: alice.userId, expiresAt: past, updatedAt: past },
      { id: "live", token: "b", userId: alice.userId, expiresAt: future, updatedAt: past },
    ]);
    await app.db.insert(verification).values([
      { id: "v-old", identifier: "x", value: "1", expiresAt: past, updatedAt: past },
      { id: "v-live", identifier: "y", value: "2", expiresAt: future, updatedAt: past },
    ]);
    await app.db.insert(rateLimit).values([
      { id: "r-old", key: "old", count: 1, lastRequest: now - RETENTION.rateLimitMs - 1 },
      { id: "r-live", key: "live", count: 1, lastRequest: now },
    ]);
    const long = new Date(now - RETENTION.inviteMs - 1000).toISOString();
    const soon = new Date(now + 3600_000).toISOString();
    await app.db.insert(workspaceInvites).values([
      { id: "i-old", workspaceId: alice.workspaceId, email: "x@example.com", tokenHash: "h1", role: "member", expiresAt: long },
      { id: "i-live", workspaceId: alice.workspaceId, email: "y@example.com", tokenHash: "h2", role: "member", expiresAt: soon },
    ]);

    await app.db.insert(desktopApprovals).values([
      { stateHash: "used-long-ago", createdAt: new Date(now - RETENTION.desktopApprovalMs - 1000).toISOString() },
      { stateHash: "used-today", createdAt: new Date(now - 60_000).toISOString() },
    ]);

    const idle = new Date(now - ACCESS_TOKEN_IDLE_MS - 1000).toISOString();
    await app.db.insert(accessTokens).values([
      { id: "t-never-used", userId: alice.userId, name: "forgotten", tokenHash: "t1", createdAt: idle },
      { id: "t-long-unused", userId: alice.userId, name: "old laptop", tokenHash: "t2", createdAt: idle, lastUsedAt: idle },
      { id: "t-in-use", userId: alice.userId, name: "laptop", tokenHash: "t3", createdAt: idle, lastUsedAt: new Date(now - 60_000).toISOString() },
      { id: "t-new", userId: alice.userId, name: "new laptop", tokenHash: "t4", createdAt: new Date(now - 60_000).toISOString() },
    ]);

    expect(await pruneOldRecords(app.ctx, now)).toEqual({ sessions: 1, verifications: 1, rateLimits: 1, invites: 1, desktopApprovals: 1, accessTokens: 2 });
    expect((await app.db.select().from(desktopApprovals)).map(a => a.stateHash)).toEqual(["used-today"]);
    expect((await app.db.select().from(accessTokens)).map(t => t.id).sort()).toEqual(["t-in-use", "t-new"]);
    expect((await app.db.select().from(session)).map(s => s.id)).toEqual(["live"]);
    expect((await app.db.select().from(verification)).map(v => v.id)).toEqual(["v-live"]);
    expect((await app.db.select().from(rateLimit)).map(r => r.id)).toEqual(["r-live"]);
    expect((await app.db.select().from(workspaceInvites)).map(i => i.id)).toEqual(["i-live"]);
  });
});
