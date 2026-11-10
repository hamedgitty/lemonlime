import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { computers, workspaceMembers, workspaces } from "@lemonlime/db";
import { deriveBridgeKey, verifyBridgeTicket, type LocalThreadSnapshot } from "@lemonlime/protocol";
import { computerThreadResponse, forgetComputer, linkTicket, listComputerThreads, saveComputer } from "../src/lib/computers.ts";
import type { BridgeControl } from "../src/lib/phone-bridge.ts";
import { HttpError } from "../src/lib/errors.ts";
import { TEST_ENV, addUser, createTestApp } from "./helpers.ts";

/** Who may see and reach a computer's threads through the phone bridge. */

const COMPUTER = "computer-0123456789abcdef";

function fakeBridge(linked = true) {
  const killed: string[] = [];
  const control: BridgeControl = {
    linked: async () => linked,
    kill: async id => {
      killed.push(id);
    },
  };
  return { control, killed };
}

function snapshot(id: string, over: Partial<LocalThreadSnapshot> = {}): LocalThreadSnapshot {
  const now = new Date().toISOString();
  return {
    id,
    title: "Fix the login page",
    agent: { kind: "claude-code" },
    repoName: "app",
    branch: `agent/${id}`,
    status: "idle",
    latestSeq: 3,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

async function setup() {
  const app = await createTestApp();
  const owner = await addUser(app.db, "owner@example.com");
  const other = await addUser(app.db, "other@example.com");
  const bridge = fakeBridge();
  await saveComputer(app.ctx, bridge.control, owner.userId, owner.workspaceId, COMPUTER, {
    name: "Studio Mac",
    platform: "mac",
    phoneAccess: true,
    threads: [snapshot("thread-aaaaaa")],
  });
  return { ...app, owner, other, bridge };
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

describe("computers and phone access", () => {
  it("gives the owner a phone ticket for a shared thread on a linked computer", async () => {
    const { ctx, owner, bridge } = await setup();
    const res = await computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, "thread-aaaaaa");
    expect(res.thread.mode).toBe("local");
    expect(res.computer).toMatchObject({ name: "Studio Mac", online: true });
    expect(res.endpoint?.url).toBe(`ws://localhost:3000/api/phone/ws/${COMPUTER}/thread-aaaaaa`);
    const ticket = await verifyBridgeTicket(res.endpoint!.token, await deriveBridgeKey(TEST_ENV.LEMONLIME_TOKEN_SECRET));
    expect(ticket).toMatchObject({ kind: "phone", computerId: COMPUTER, threadId: "thread-aaaaaa", userId: owner.userId, epoch: 0 });
  });

  it("never lets someone else reach the computer, even in the same workspace", async () => {
    const { ctx, db, owner, other, bridge } = await setup();
    await db.insert(workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    expect(await status(computerThreadResponse(ctx, bridge.control, other.userId, COMPUTER, "thread-aaaaaa"))).toBe(404);
    expect(await status(linkTicket(ctx, bridge.control, other.userId, COMPUTER))).toBe(404);
    // Nor take over its id.
    expect(
      await status(saveComputer(ctx, bridge.control, other.userId, owner.workspaceId, COMPUTER, { name: "Mine now", platform: "mac", phoneAccess: true })),
    ).toBe(404);
    expect(await listComputerThreads(ctx, other.userId, owner.workspaceId)).toEqual([]);
    // Forgetting someone else's computer does nothing.
    await forgetComputer(ctx, bridge.control, other.userId, COMPUTER);
    expect(bridge.killed).toEqual([]);
    expect(await db.select().from(computers).where(eq(computers.id, COMPUTER)).get()).toBeTruthy();
  });

  it("cuts the owner off once they leave the computer's workspace", async () => {
    const { ctx, db, owner, bridge } = await setup();
    // A team workspace the owner joins, links the computer in, then leaves.
    const team = crypto.randomUUID();
    await db.insert(workspaces).values({ id: team, name: "Team", personal: false, createdBy: owner.userId });
    await db.insert(workspaceMembers).values({ workspaceId: team, userId: owner.userId, role: "member" });
    await saveComputer(ctx, bridge.control, owner.userId, team, COMPUTER, {
      name: "Studio Mac",
      platform: "mac",
      phoneAccess: true,
      threads: [snapshot("thread-aaaaaa")],
    });
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, team), eq(workspaceMembers.userId, owner.userId)));
    expect(await status(computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, "thread-aaaaaa"))).toBe(404);
    expect(await status(linkTicket(ctx, bridge.control, owner.userId, COMPUTER))).toBe(404);
    expect(await status(listComputerThreads(ctx, owner.userId, team))).toBe(403);
  });

  it("only opens threads the computer shares", async () => {
    const { ctx, owner, bridge } = await setup();
    expect(await status(computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, "thread-bbbbbb"))).toBe(404);
  });

  it("has no endpoint while the computer isn't linked, and still shows the last known state", async () => {
    const { ctx, owner } = await setup();
    const res = await computerThreadResponse(ctx, fakeBridge(false).control, owner.userId, COMPUTER, "thread-aaaaaa");
    expect(res.endpoint).toBeNull();
    expect(res.computer.online).toBe(false);
    expect(res.thread.status).toBe("idle");
    // Without a bridge on this server at all, too.
    expect((await computerThreadResponse(ctx, null, owner.userId, COMPUTER, "thread-aaaaaa")).endpoint).toBeNull();
  });

  it("turning phone access off forgets the threads, voids old tickets and cuts sessions", async () => {
    const { ctx, db, owner, bridge } = await setup();
    const before = await linkTicket(ctx, bridge.control, owner.userId, COMPUTER);
    await saveComputer(ctx, bridge.control, owner.userId, owner.workspaceId, COMPUTER, { name: "Studio Mac", platform: "mac", phoneAccess: false });
    expect(bridge.killed).toEqual([COMPUTER]);
    const row = await db.select().from(computers).where(eq(computers.id, COMPUTER)).get();
    expect(row).toMatchObject({ phoneAccess: false, threads: [], epoch: 1 });
    expect(await status(computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, "thread-aaaaaa"))).toBe(404);
    expect(await status(linkTicket(ctx, bridge.control, owner.userId, COMPUTER))).toBe(409);
    expect(await listComputerThreads(ctx, owner.userId, owner.workspaceId)).toEqual([]);

    // On again: new tickets carry the new epoch, so the bridge refuses the old ones.
    await saveComputer(ctx, bridge.control, owner.userId, owner.workspaceId, COMPUTER, { name: "Studio Mac", platform: "mac", phoneAccess: true });
    const key = await deriveBridgeKey(TEST_ENV.LEMONLIME_TOKEN_SECRET);
    const after = await linkTicket(ctx, bridge.control, owner.userId, COMPUTER);
    expect((await verifyBridgeTicket(before.ticket, key))?.epoch).toBe(0);
    expect((await verifyBridgeTicket(after.ticket, key))?.epoch).toBe(1);
  });

  it("says phone access is unavailable when this server has no bridge", async () => {
    const { ctx, owner } = await setup();
    expect(await status(linkTicket(ctx, null, owner.userId, COMPUTER))).toBe(503);
    const saved = await saveComputer(ctx, null, owner.userId, owner.workspaceId, COMPUTER, { name: "Studio Mac", platform: "mac", phoneAccess: true });
    expect(saved.bridgeAvailable).toBe(false);
  });

  it("lists the owner's computers with phone access on", async () => {
    const { ctx, owner } = await setup();
    const list = await listComputerThreads(ctx, owner.userId, owner.workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]!.computer).toMatchObject({ id: COMPUTER, name: "Studio Mac", online: true });
    expect(list[0]!.threads.map(t => t.id)).toEqual(["thread-aaaaaa"]);
  });

  it("tells the dashboard whether a computer only answers paired phones", async () => {
    const { ctx, owner, bridge } = await setup();
    const checkIn = (sealed?: boolean) =>
      saveComputer(ctx, bridge.control, owner.userId, owner.workspaceId, COMPUTER, {
        name: "Studio Mac",
        platform: "mac",
        phoneAccess: true,
        ...(sealed === undefined ? {} : { sealed }),
        threads: [snapshot("thread-aaaaaa")],
      });
    const seen = async () => ({
      listed: (await listComputerThreads(ctx, owner.userId, owner.workspaceId))[0]!.computer.sealed,
      opened: (await computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, "thread-aaaaaa")).computer.sealed,
    });

    // A desktop app that doesn't say (one from before pairing) doesn't seal.
    expect(await seen()).toEqual({ listed: false, opened: false });

    expect((await checkIn(true)).sealed).toBe(true);
    expect(await seen()).toEqual({ listed: true, opened: true });

    // It is what the app said last: going back to an older app shows as not sealing again.
    expect((await checkIn()).sealed).toBe(false);
    expect(await seen()).toEqual({ listed: false, opened: false });
  });
});
