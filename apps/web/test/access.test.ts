import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accessTokens, threads, workspaceMembers, workspaces } from "@lemonlime/db";
import {
  ACCESS_TOKEN_IDLE_MS,
  createAccessTokenRow,
  deleteIdleAccessTokens,
  findThreadForUser,
  findUserByTokenHash,
  getThreadForUser,
  isWorkspaceMember,
  listAccessTokens,
  listThreadsForUser,
  personalWorkspaceName,
  requireWorkspaceMember,
  resolveWorkspace,
  revokeAccessToken,
  userWorkspaceIds,
} from "../src/lib/access.ts";
import { HttpError } from "../src/lib/errors.ts";
import { addUser, createTestApp } from "./helpers.ts";

async function setup() {
  const { db } = await createTestApp();
  const alice = await addUser(db, "alice@example.com");
  const bob = await addUser(db, "bob@example.com");
  const insertThread = async (id: string, workspaceId: string, createdBy: string) => {
    await db.insert(threads).values({
      id,
      workspaceId,
      createdBy,
      agent: { kind: "claude-code" },
      repo: { url: "/tmp/repo", baseBranch: "main" },
      branch: `agent/${id}`,
      mode: "local",
      status: "idle",
    });
  };
  await insertThread("alice-thread-1", alice.workspaceId, alice.userId);
  await insertThread("bob-thread-1", bob.workspaceId, bob.userId);
  return { db, alice, bob };
}

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("workspace membership", () => {
  it("names personal workspaces after the email's local part", () => {
    expect(personalWorkspaceName("ada@example.com")).toBe("ada");
    expect(personalWorkspaceName("")).toBe("Personal");
    expect(personalWorkspaceName(null)).toBe("Personal");
  });

  it("knows who belongs where", async () => {
    const { db, alice, bob } = await setup();
    expect(await isWorkspaceMember(db, alice.userId, alice.workspaceId)).toBe(true);
    expect(await isWorkspaceMember(db, alice.userId, bob.workspaceId)).toBe(false);
    expect(await status(requireWorkspaceMember(db, alice.userId, bob.workspaceId))).toBe(403);
    expect(await userWorkspaceIds(db, alice.userId)).toEqual([alice.workspaceId]);
  });

  it("resolves the requested workspace only for members", async () => {
    const { db, alice, bob } = await setup();
    expect(await resolveWorkspace(db, alice.userId)).toBe(alice.workspaceId);
    expect(await resolveWorkspace(db, alice.userId, alice.workspaceId)).toBe(alice.workspaceId);
    expect(await status(resolveWorkspace(db, alice.userId, bob.workspaceId))).toBe(403);
    expect(await status(resolveWorkspace(db, alice.userId, "no-such-workspace"))).toBe(403);
  });

  it("gives shared workspaces to every member", async () => {
    const { db, alice, bob } = await setup();
    const team = crypto.randomUUID();
    await db.insert(workspaces).values({ id: team, name: "Team", createdBy: alice.userId });
    await db.insert(workspaceMembers).values([
      { workspaceId: team, userId: alice.userId, role: "owner" },
      { workspaceId: team, userId: bob.userId, role: "member" },
    ]);
    expect(await resolveWorkspace(db, bob.userId, team)).toBe(team);
    // The first workspace is still the personal one.
    expect(await resolveWorkspace(db, bob.userId)).toBe(bob.workspaceId);
  });

  it("creates a personal workspace for a user who has none", async () => {
    const { db } = await setup();
    const { user } = await import("@lemonlime/db");
    await db.insert(user).values({ id: "orphan", name: "", email: "orphan@example.com", updatedAt: new Date() });
    const ids = await userWorkspaceIds(db, "orphan", "orphan@example.com");
    expect(ids).toHaveLength(1);
    expect(await isWorkspaceMember(db, "orphan", ids[0]!)).toBe(true);
    // And only once.
    expect(await userWorkspaceIds(db, "orphan")).toEqual(ids);
  });
});

describe("thread access", () => {
  it("returns threads only to members of their workspace", async () => {
    const { db, alice, bob } = await setup();
    expect((await getThreadForUser(db, alice.userId, "alice-thread-1")).id).toBe("alice-thread-1");
    expect(await findThreadForUser(db, alice.userId, "bob-thread-1")).toBeNull();
    // Someone else's thread looks exactly like a missing one.
    expect(await status(getThreadForUser(db, alice.userId, "bob-thread-1"))).toBe(404);
    expect(await status(getThreadForUser(db, alice.userId, "missing-thread"))).toBe(404);
    expect(await status(getThreadForUser(db, bob.userId, "alice-thread-1"))).toBe(404);
  });

  it("lists a workspace's threads only for members", async () => {
    const { db, alice, bob } = await setup();
    expect((await listThreadsForUser(db, alice.userId, alice.workspaceId)).map(t => t.id)).toEqual(["alice-thread-1"]);
    expect(await status(listThreadsForUser(db, alice.userId, bob.workspaceId))).toBe(403);
  });

  it("loses access when membership is removed", async () => {
    const { db, alice } = await setup();
    const { and, eq } = await import("drizzle-orm");
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, alice.workspaceId), eq(workspaceMembers.userId, alice.userId)));
    expect(await findThreadForUser(db, alice.userId, "alice-thread-1")).toBeNull();
  });
});

describe("access token ownership", () => {
  it("lists, finds and revokes only the owner's tokens", async () => {
    const { db, alice, bob } = await setup();
    const token = await createAccessTokenRow(db, alice.userId, "laptop", "a".repeat(64));
    expect(token).toMatchObject({ name: "laptop", lastUsedAt: null });
    expect((await listAccessTokens(db, alice.userId)).map(t => t.id)).toEqual([token.id]);
    expect(await listAccessTokens(db, bob.userId)).toEqual([]);
    // Listing never exposes the hash.
    expect(Object.keys((await listAccessTokens(db, alice.userId))[0]!).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name"]);

    expect(await revokeAccessToken(db, bob.userId, token.id)).toBe(false);
    expect(await findUserByTokenHash(db, "a".repeat(64))).toBe(alice.userId);
    expect(await revokeAccessToken(db, alice.userId, token.id)).toBe(true);
    expect(await findUserByTokenHash(db, "a".repeat(64))).toBeNull();
  });
});

describe("access tokens left unused", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HASH = "b".repeat(64);
  const lastUsed = async (db: Awaited<ReturnType<typeof setup>>["db"]) =>
    (await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, HASH)).get())!.lastUsedAt;

  it("stop working after 90 days without use, and keep working for as long as they are used", async () => {
    const { db, alice } = await setup();
    const made = Date.parse("2026-01-01T00:00:00.000Z");
    await db.insert(accessTokens).values({ userId: alice.userId, name: "laptop", tokenHash: HASH, createdAt: new Date(made).toISOString() });

    // Used every couple of months, it never runs out.
    let now = made;
    for (let i = 0; i < 4; i++) {
      now += 60 * DAY;
      expect(await findUserByTokenHash(db, HASH, now)).toBe(alice.userId);
    }
    // Left alone for 90 days, it is refused, and stays refused.
    expect(await findUserByTokenHash(db, HASH, now + ACCESS_TOKEN_IDLE_MS)).toBe(alice.userId);
    const late = now + ACCESS_TOKEN_IDLE_MS + ACCESS_TOKEN_IDLE_MS + 1000;
    expect(await findUserByTokenHash(db, HASH, late)).toBeNull();
    expect(await findUserByTokenHash(db, HASH, late + 1000)).toBeNull();
  });

  it("count from the day they were made when they were never used", async () => {
    const { db, alice } = await setup();
    const made = Date.parse("2026-01-01T00:00:00.000Z");
    await db.insert(accessTokens).values({ userId: alice.userId, name: "spare", tokenHash: HASH, createdAt: new Date(made).toISOString() });
    expect(await findUserByTokenHash(db, HASH, made + ACCESS_TOKEN_IDLE_MS + 1000)).toBeNull();
    // Being refused is not a use.
    expect(await lastUsed(db)).toBeNull();
    expect(await findUserByTokenHash(db, HASH, made + 89 * DAY)).toBe(alice.userId);
  });

  it("have their use written down at most once an hour", async () => {
    const { db, alice } = await setup();
    const made = Date.parse("2026-01-01T00:00:00.000Z");
    await db.insert(accessTokens).values({ userId: alice.userId, name: "laptop", tokenHash: HASH, createdAt: new Date(made).toISOString() });
    const at = (ms: number) => new Date(made + ms).toISOString();

    await findUserByTokenHash(db, HASH, made + 1000);
    expect(await lastUsed(db)).toBe(at(1000));
    await findUserByTokenHash(db, HASH, made + 30 * 60_000);
    expect(await lastUsed(db)).toBe(at(1000));
    await findUserByTokenHash(db, HASH, made + 61 * 60_000);
    expect(await lastUsed(db)).toBe(at(61 * 60_000));
  });

  it("are deleted by the clean-up once they can no longer work", async () => {
    const { db, alice } = await setup();
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    const long = new Date(now - ACCESS_TOKEN_IDLE_MS - DAY).toISOString();
    await db.insert(accessTokens).values([
      { userId: alice.userId, name: "never used", tokenHash: "n".repeat(64), createdAt: long },
      { userId: alice.userId, name: "still used", tokenHash: HASH, createdAt: long, lastUsedAt: new Date(now - DAY).toISOString() },
    ]);
    expect(await deleteIdleAccessTokens(db, now)).toBe(1);
    expect((await listAccessTokens(db, alice.userId)).map(t => t.name)).toEqual(["still used"]);
    expect(await findUserByTokenHash(db, HASH, now)).toBe(alice.userId);
  });
});
