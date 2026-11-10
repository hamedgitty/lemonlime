import { describe, expect, it } from "vitest";
import type { CreateThreadRequest, ThreadEvent } from "@lemonlime/protocol";
import { ackPendingMessages, addPendingMessage, appendHistory, listPendingMessages, PENDING_MESSAGES_MAX, readHistory } from "../src/lib/history.ts";
import { hit, LIMITS } from "../src/lib/rate-limit.ts";
import { createThread, getThreadRow, pauseThread, queueMessage, recordHeartbeat } from "../src/lib/threads.ts";
import { addUser, createTestApp } from "./helpers.ts";

const cloudThread: CreateThreadRequest = {
  agent: { kind: "claude-code" },
  repo: { url: "https://github.com/example/app.git", baseBranch: "main" },
  mode: "cloud",
  sandboxSize: "small",
};

const at = "2026-01-01T00:00:00.000Z";
const events = (threadId: string, from: number, to: number): ThreadEvent[] =>
  Array.from(
    { length: to - from + 1 },
    (_, i) => ({ threadId, seq: from + i, at, type: "agent_message", text: `m${from + i}`, partial: false }) as ThreadEvent,
  );

async function setup() {
  const app = await createTestApp();
  const alice = await addUser(app.db, "alice@example.com");
  const created = await createThread(app.ctx, alice.userId, alice.workspaceId, cloudThread);
  const row = async () => (await getThreadRow(app.ctx, created.thread.id))!;
  return { ...app, alice, id: created.thread.id, row };
}

describe("thread history storage", () => {
  it("keeps history in order, skips repeats, and refuses gaps", async () => {
    const { ctx, id, row, history } = await setup();
    expect(await appendHistory(ctx, await row(), events(id, 1, 3))).toEqual({ storedSeq: 3 });
    // A retry that overlaps only stores the new part.
    expect(await appendHistory(ctx, await row(), events(id, 2, 5))).toEqual({ storedSeq: 5 });
    // A gap stores nothing and says where to continue from.
    expect(await appendHistory(ctx, await row(), events(id, 8, 9))).toEqual({ storedSeq: 5 });
    expect(history.objects.size).toBe(2);

    const all = await readHistory(ctx, id, 0);
    expect(all.events.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.more).toBe(false);
    expect((await readHistory(ctx, id, 3)).events.map(e => e.seq)).toEqual([4, 5]);
    const page = await readHistory(ctx, id, 0, 2);
    expect(page).toMatchObject({ more: true });
    expect(page.events.map(e => e.seq)).toEqual([1, 2]);
  });

  it("refuses events from another thread", async () => {
    const { ctx, row } = await setup();
    await expect(appendHistory(ctx, await row(), events("someone-else", 1, 1))).rejects.toMatchObject({ status: 400 });
  });
});

describe("messages sent while paused", () => {
  it("are saved once, counted in heartbeats, and forgotten once the runner has them", async () => {
    const { ctx, alice, id } = await setup();
    await pauseThread(ctx, alice.userId, id);
    await addPendingMessage(ctx, id, { clientMsgId: "m1", text: "keep going" });
    await addPendingMessage(ctx, id, { clientMsgId: "m1", text: "keep going" });
    await addPendingMessage(ctx, id, { clientMsgId: "m2", text: "and add tests" });
    expect(await listPendingMessages(ctx, id)).toEqual([
      { clientMsgId: "m1", text: "keep going" },
      { clientMsgId: "m2", text: "and add tests" },
    ]);
    // Resume as the messages route does, then the runner's first heartbeat hears about them.
    const { resumeThread } = await import("../src/lib/threads.ts");
    await resumeThread(ctx, alice.userId, id);
    const hb = await recordHeartbeat(ctx, { threadId: id, status: "idle", latestSeq: 0, idleSince: at, runnerVersion: "test" });
    expect(hb.pendingMessages).toBe(2);
    await ackPendingMessages(ctx, id, ["m1", "m2"]);
    expect(await listPendingMessages(ctx, id)).toEqual([]);
  });

  it("are saved and wake the sandbox, for members of the thread's workspace only", async () => {
    const { ctx, db, sandbox, alice, id } = await setup();
    const mallory = await addUser(db, "mallory@example.com");
    await pauseThread(ctx, alice.userId, id);

    await expect(queueMessage(ctx, mallory.userId, id, { clientMsgId: "m0", text: "let me in" })).rejects.toMatchObject({ status: 404 });
    expect(await listPendingMessages(ctx, id)).toEqual([]);

    const sent = await queueMessage(ctx, alice.userId, id, { clientMsgId: "m1", text: "keep going" });
    expect(sent.thread.status).toBe("provisioning");
    expect(sandbox.calls).toContain("resume:sb-1");
    // Sending it again changes nothing.
    await queueMessage(ctx, alice.userId, id, { clientMsgId: "m1", text: "keep going" });
    expect(await listPendingMessages(ctx, id)).toEqual([{ clientMsgId: "m1", text: "keep going" }]);
    expect(sandbox.calls.filter(c => c === "resume:sb-1")).toHaveLength(1);
  });

  it("are not saved once the sender has sent too many too fast", async () => {
    const { ctx, db, sandbox, alice, id } = await setup();
    await pauseThread(ctx, alice.userId, id);
    for (let i = 0; i < LIMITS.messagesPerUser.max; i++) await hit(db, `messages:${alice.userId}`, LIMITS.messagesPerUser);

    const err = await queueMessage(ctx, alice.userId, id, { clientMsgId: "m1", text: "one more" }).catch(e => e);
    expect(err).toMatchObject({ status: 429 });
    expect(err.message).toMatch(/^Too many messages\. Try again in /);
    expect(await listPendingMessages(ctx, id)).toEqual([]);
    expect(sandbox.calls).not.toContain("resume:sb-1");
  });

  it("are not saved, or the sandbox woken, once the sender has started too many sandboxes", async () => {
    const { ctx, db, sandbox, alice, id } = await setup();
    await pauseThread(ctx, alice.userId, id);
    for (let i = 0; i < LIMITS.sandboxStartsPerUser.max; i++) await hit(db, `sandbox-starts:${alice.userId}`, LIMITS.sandboxStartsPerUser);

    await expect(queueMessage(ctx, alice.userId, id, { clientMsgId: "m1", text: "wake up" })).rejects.toMatchObject({ status: 429 });
    expect(await listPendingMessages(ctx, id)).toEqual([]);
    expect(sandbox.calls).not.toContain("resume:sb-1");
  });

  it("stop being taken once too many are waiting for one thread", async () => {
    const { ctx, alice, id } = await setup();
    await pauseThread(ctx, alice.userId, id);
    for (let i = 0; i < PENDING_MESSAGES_MAX; i++) await addPendingMessage(ctx, id, { clientMsgId: `m${i}`, text: "and another thing" });

    const err = await queueMessage(ctx, alice.userId, id, { clientMsgId: "one-too-many", text: "and this" }).catch(e => e);
    expect(err).toMatchObject({ status: 429, message: "Too many messages are waiting for this thread. Let the agent catch up, then send it again." });
    expect(await listPendingMessages(ctx, id)).toHaveLength(PENDING_MESSAGES_MAX);

    // One that is already waiting can be sent again, and still wakes the sandbox.
    expect((await queueMessage(ctx, alice.userId, id, { clientMsgId: "m3", text: "and another thing" })).thread.status).toBe("provisioning");
    expect(await listPendingMessages(ctx, id)).toHaveLength(PENDING_MESSAGES_MAX);
  });

  it("are refused for local threads and for threads whose sandbox is gone", async () => {
    const { ctx, alice, id } = await setup();
    const local = await createThread(ctx, alice.userId, alice.workspaceId, {
      ...cloudThread,
      mode: "local",
      repo: { url: "/home/me/app", baseBranch: "main" },
    });
    await expect(queueMessage(ctx, alice.userId, local.thread.id, { clientMsgId: "m1", text: "hello" })).rejects.toMatchObject({ status: 409 });
    const { deleteThread } = await import("../src/lib/threads.ts");
    await deleteThread(ctx, alice.userId, id);
    await expect(queueMessage(ctx, alice.userId, id, { clientMsgId: "m1", text: "hello" })).rejects.toMatchObject({ status: 409 });
    expect(await listPendingMessages(ctx, id)).toEqual([]);
  });
});
