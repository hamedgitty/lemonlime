import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { threads } from "@lemonlime/db";
import { canTakePart, type CreateThreadRequest } from "@lemonlime/protocol";
import { ONLY_THE_STARTER, STARTER_HAS_LEFT } from "../src/lib/access.ts";
import { listPendingMessages } from "../src/lib/history.ts";
import {
  createThread,
  deleteThread,
  getThreadRowForUser,
  getThreadRowToTakePart,
  listThreads,
  ONLY_THE_STARTER_SHARES,
  pauseThread,
  queueMessage,
  renameThread,
  requestAgentSignIn,
  resumeThread,
  ThreadChange,
  threadResponse,
  updateThread,
} from "../src/lib/threads.ts";
import { deleteThreadForever } from "../src/lib/account.ts";
import { removeMember } from "../src/lib/members.ts";
import { addTeam, addUser, createTestApp } from "./helpers.ts";

const cloudThread: CreateThreadRequest = {
  agent: { kind: "codex" },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  mode: "cloud",
  sandboxSize: "small",
};

/** A team with an owner and two members; Bob, a member, starts a cloud thread in it. */
async function teamThread() {
  const app = await createTestApp();
  const owner = await addUser(app.db, "owner@example.com");
  const bob = await addUser(app.db, "bob@example.com");
  const carol = await addUser(app.db, "carol@example.com");
  const teamId = await addTeam(app.db, owner.userId, [bob.userId, carol.userId]);
  const { thread } = await createThread(app.ctx, bob.userId, teamId, cloudThread);
  const view = async (userId: string) => threadResponse(app.ctx, await getThreadRowForUser(app.ctx, userId, thread.id), userId);
  return { ...app, owner, bob, carol, teamId, id: thread.id, view };
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => "allowed",
    (e: { status?: number; message?: string }) => `${e.status}: ${e.message}`,
  );

describe("taking part in a thread", () => {
  it("is for the person who started it; everyone else in the workspace can read it", async () => {
    const { ctx, bob, carol, owner, teamId, id, view } = await teamThread();

    const bobs = await view(bob.userId);
    expect(bobs.thread).toMatchObject({ mine: true, shared: false });
    expect(bobs.endpoint).not.toBeNull();
    expect(canTakePart(bobs.thread)).toBe(true);

    // Other members, the owner included, see the thread but are handed no way into its sandbox.
    for (const other of [carol, owner]) {
      const seen = await view(other.userId);
      expect(seen.thread).toMatchObject({ id, mine: false, shared: false });
      expect(seen.endpoint).toBeNull();
      expect(canTakePart(seen.thread)).toBe(false);
      expect((await listThreads(ctx, other.userId, teamId)).map(t => [t.id, t.mine, t.shared])).toEqual([[id, false, false]]);
    }
    expect((await listThreads(ctx, bob.userId, teamId)).map(t => [t.id, t.mine])).toEqual([[id, true]]);
  });

  it("refuses everyone else whatever would direct the agent or change the thread, in plain words", async () => {
    const { ctx, sandbox, bob, carol, id } = await teamThread();
    const no = `403: ${ONLY_THE_STARTER}`;
    expect(ONLY_THE_STARTER).toBe("Only the person who started this thread can do that, unless they share it with the workspace.");

    expect(await refusal(queueMessage(ctx, carol.userId, id, { clientMsgId: "m1", text: "do this instead" }))).toBe(no);
    expect(await refusal(renameThread(ctx, carol.userId, id, "Mine now"))).toBe(no);
    // Opening a pull request, and anything else that starts from this check.
    expect(await refusal(getThreadRowToTakePart(ctx, carol.userId, id))).toBe(no);
    expect(await refusal(pauseThread(ctx, carol.userId, id))).toBe(no);
    await pauseThread(ctx, bob.userId, id);
    expect(await refusal(resumeThread(ctx, carol.userId, id))).toBe(no);
    expect(await refusal(queueMessage(ctx, carol.userId, id, { clientMsgId: "m2", text: "wake up" }))).toBe(no);

    // Nothing was saved, renamed or woken.
    expect(await listPendingMessages(ctx, id)).toEqual([]);
    expect(sandbox.calls).toEqual([`create:${id}`, "pause:sb-1"]);
    expect((await getThreadRowForUser(ctx, carol.userId, id)).title).toBe("codex on app");

    // Someone outside the workspace is still told there is no such thread.
    const mallory = await addUser(ctx.db, "mallory@example.com");
    expect(await refusal(getThreadRowToTakePart(ctx, mallory.userId, id))).toBe("404: Thread not found.");
  });

  it("opens to the whole workspace when the person who started it shares it, and closes again when they stop", async () => {
    const { ctx, sandbox, bob, carol, owner, id, view } = await teamThread();

    // Only the starter can share it: not another member, and not an owner.
    for (const other of [carol, owner]) {
      expect(await refusal(updateThread(ctx, other.userId, id, { shared: true }))).toBe(`403: ${ONLY_THE_STARTER_SHARES}`);
    }
    expect((await view(carol.userId)).thread.shared).toBe(false);

    const shared = await updateThread(ctx, bob.userId, id, { shared: true });
    expect(shared.thread).toMatchObject({ mine: true, shared: true });

    const carols = await view(carol.userId);
    expect(carols.thread).toMatchObject({ mine: false, shared: true });
    expect(carols.endpoint).not.toBeNull();
    expect(canTakePart(carols.thread)).toBe(true);
    expect((await renameThread(ctx, carol.userId, id, "Carol was here")).thread.title).toBe("Carol was here");
    expect((await pauseThread(ctx, carol.userId, id)).thread.status).toBe("paused");
    expect((await queueMessage(ctx, carol.userId, id, { clientMsgId: "m1", text: "carry on" })).endpoint).not.toBeNull();
    expect(sandbox.calls).toContain("resume:sb-1");

    // Sharing still isn't Carol's to change, and the agent's sign-in stays the starter's.
    expect(await refusal(updateThread(ctx, carol.userId, id, { shared: false }))).toBe(`403: ${ONLY_THE_STARTER_SHARES}`);
    expect(await refusal(updateThread(ctx, carol.userId, id, { title: "Renamed", shared: false }))).toBe(`403: ${ONLY_THE_STARTER_SHARES}`);
    expect((await view(carol.userId)).thread.title).toBe("Carol was here");
    expect(await refusal(requestAgentSignIn(ctx, carol.userId, id))).toBe("403: Only the person who started this thread can sign its agent in.");

    await updateThread(ctx, bob.userId, id, { shared: false });
    expect((await view(carol.userId)).endpoint).toBeNull();
    expect(await refusal(queueMessage(ctx, carol.userId, id, { clientMsgId: "m2", text: "one more" }))).toBe(`403: ${ONLY_THE_STARTER}`);
  });

  it("lets a workspace owner pause and close any thread, without a way into its sandbox", async () => {
    const { ctx, sandbox, owner, id } = await teamThread();
    const paused = await pauseThread(ctx, owner.userId, id);
    expect(paused.thread.status).toBe("paused");
    expect(paused.endpoint).toBeNull();
    expect(sandbox.calls).toContain("pause:sb-1");
    // Waking it would start the agent again on the starter's account.
    expect(await refusal(resumeThread(ctx, owner.userId, id))).toBe(`403: ${ONLY_THE_STARTER}`);

    const closed = await deleteThread(ctx, owner.userId, id);
    expect(closed.thread.status).toBe("stopped");
    expect(closed.endpoint).toBeNull();
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
  });

  it("can only be read once the person who started it is gone, though an owner can still close it", async () => {
    const { ctx, db, sandbox, bob, carol, owner, id, view } = await teamThread();
    await updateThread(ctx, bob.userId, id, { shared: true });
    // Bob's account is deleted: the thread stays with the team, started by nobody.
    await db.update(threads).set({ createdBy: null }).where(eq(threads.id, id));

    for (const member of [carol, owner]) {
      const seen = await view(member.userId);
      // Sharing was Bob's to give, with his agent sign-in: it ends with him.
      expect(seen.thread).toMatchObject({ mine: false, shared: false });
      expect(seen.endpoint).toBeNull();
      expect(await refusal(queueMessage(ctx, member.userId, id, { clientMsgId: "m1", text: "anyone there?" }))).toBe(`403: ${STARTER_HAS_LEFT}`);
      expect(await refusal(renameThread(ctx, member.userId, id, "Orphan"))).toBe(`403: ${STARTER_HAS_LEFT}`);
      expect(await refusal(updateThread(ctx, member.userId, id, { shared: true }))).toBe(`403: ${ONLY_THE_STARTER_SHARES}`);
    }
    expect(await refusal(pauseThread(ctx, carol.userId, id))).toBe(`403: ${STARTER_HAS_LEFT}`);
    expect(await refusal(deleteThread(ctx, carol.userId, id))).toBe("403: Only the person who started this thread or a workspace owner can close it.");
    expect(await refusal(deleteThreadForever(ctx, carol.userId, id))).toBe("403: Only the person who started this thread or a workspace owner can delete it.");

    expect((await pauseThread(ctx, owner.userId, id)).thread.status).toBe("paused");
    expect(await refusal(resumeThread(ctx, owner.userId, id))).toBe(`403: ${STARTER_HAS_LEFT}`);
    expect((await deleteThread(ctx, owner.userId, id)).thread.status).toBe("stopped");
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
  });

  it("stops being shared when the person who started it leaves the workspace", async () => {
    const { ctx, db, sandbox, bob, carol, owner, teamId, id, view } = await teamThread();
    await updateThread(ctx, bob.userId, id, { shared: true });
    expect((await view(carol.userId)).endpoint).not.toBeNull();
    const [before] = await db.select({ updatedAt: threads.updatedAt }).from(threads).where(eq(threads.id, id));

    await removeMember(ctx, { userId: owner.userId, workspaceId: teamId, memberId: bob.userId });

    // The team keeps the conversation, in the same place in its list, but nobody acts through Bob's sign-in any more.
    const seen = await view(carol.userId);
    expect(seen.thread).toMatchObject({ mine: false, shared: false });
    expect(seen.endpoint).toBeNull();
    const [after] = await db.select({ updatedAt: threads.updatedAt }).from(threads).where(eq(threads.id, id));
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(await refusal(queueMessage(ctx, carol.userId, id, { clientMsgId: "m1", text: "carry on" }))).toBe(`403: ${STARTER_HAS_LEFT}`);
    expect(await refusal(renameThread(ctx, carol.userId, id, "Ours now"))).toBe(`403: ${STARTER_HAS_LEFT}`);
    // Bob is outside the workspace: the thread isn't there for him at all.
    expect(await refusal(getThreadRowForUser(ctx, bob.userId, id))).toBe("404: Thread not found.");
    expect((await deleteThread(ctx, owner.userId, id)).thread.status).toBe("stopped");
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
  });

  it("changes a thread's title, its sharing, or both, and nothing else", () => {
    expect(ThreadChange.parse({ title: "New name" })).toEqual({ title: "New name" });
    expect(ThreadChange.parse({ shared: true })).toEqual({ shared: true });
    expect(ThreadChange.parse({ title: "New name", shared: false })).toEqual({ title: "New name", shared: false });
    expect(ThreadChange.safeParse({}).success).toBe(false);
    expect(ThreadChange.safeParse({ title: "" }).success).toBe(false);
    expect(ThreadChange.safeParse({ shared: "yes" }).success).toBe(false);
    // Who started a thread can't be rewritten from outside.
    expect(ThreadChange.parse({ shared: true, createdBy: "someone-else", mine: true })).toEqual({ shared: true });
  });

  it("works as before for someone alone in their own workspace", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const { thread, endpoint } = await createThread(ctx, alice.userId, alice.workspaceId, cloudThread);
    expect(thread).toMatchObject({ mine: true, shared: false });
    expect(endpoint).not.toBeNull();
    await pauseThread(ctx, alice.userId, thread.id);
    expect((await resumeThread(ctx, alice.userId, thread.id)).endpoint).not.toBeNull();
  });
});
