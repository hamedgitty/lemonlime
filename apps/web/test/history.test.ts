import { describe, expect, it } from "vitest";
import type { CreateThreadRequest, ThreadEvent } from "@lemonlime/protocol";
import { ackPendingMessages, addPendingMessage, appendHistory, listPendingMessages, readHistory } from "../src/lib/history.ts";
import { createThread, getThreadRow, pauseThread, recordHeartbeat } from "../src/lib/threads.ts";
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
});
