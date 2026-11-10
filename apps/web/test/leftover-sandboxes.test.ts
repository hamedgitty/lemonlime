import { describe, expect, it, vi } from "vitest";
import { sandboxRuns, threads } from "@lemonlime/db";
import type { CreateThreadRequest } from "@lemonlime/protocol";
import { deleteThreadForever } from "../src/lib/account.ts";
import { createThread, deleteThread, pauseThread, resumeThread, retryLeftoverSandboxes } from "../src/lib/threads.ts";
import { addUser, createTestApp } from "./helpers.ts";

const cloudThread: CreateThreadRequest = {
  agent: { kind: "codex" },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  mode: "cloud",
  sandboxSize: "small",
};

/** Alice with one running cloud thread, and a provider that can be made to fail. */
async function runningThread() {
  const stopped: string[] = [];
  const app = await createTestApp({ policy: { onSandboxStopped: async s => void stopped.push(`${s.sandboxId}:${s.endReason}`) } });
  const alice = await addUser(app.db, "alice@example.com");
  const { thread } = await createThread(app.ctx, alice.userId, alice.workspaceId, cloudThread);
  const working = { pause: app.sandbox.pause.bind(app.sandbox), destroy: app.sandbox.destroy.bind(app.sandbox) };
  const down = async () => {
    throw new Error("503 from api.provider.internal.example for account acme-prod");
  };
  const row = async () => (await app.db.select({ status: threads.status, sandboxId: threads.sandboxId, runningSince: threads.runningSince }).from(threads))[0];
  return { ...app, alice, id: thread.id, working, down, stopped, row };
}

describe("a sandbox its provider fails to stop", () => {
  it("never keeps a thread from being closed, and is asked about again until it is gone", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, db, sandbox, alice, id, working, down, stopped, row } = await runningThread();
    sandbox.destroy = down;

    const closed = await deleteThread(ctx, alice.userId, id);
    expect(closed.thread.status).toBe("stopped");
    expect(await row()).toEqual({ status: "stopped", sandboxId: null, runningSince: null });
    // The run is recorded as over, once.
    expect(stopped).toEqual(["sb-1:user"]);
    expect(await db.select().from(sandboxRuns)).toHaveLength(1);

    // While the provider stays down, each sweep asks again and says so without its words.
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: [], errors: [{ sandboxId: "sb-1", error: "The sandbox provider could not stop it." }] });
    expect(await retryLeftoverSandboxes(ctx)).toMatchObject({ stopped: [], errors: [{ sandboxId: "sb-1" }] });

    sandbox.destroy = working.destroy;
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: ["sb-1"], errors: [] });
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
    // Once it is gone there is nothing left to ask.
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: [], errors: [] });
    expect(sandbox.calls.filter(c => c === "destroy:sb-1")).toHaveLength(1);
    quiet.mockRestore();
  });

  it("doesn't stop a thread and its history being deleted for good", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, db, sandbox, alice, id, working, down } = await runningThread();
    sandbox.destroy = down;
    await deleteThreadForever(ctx, alice.userId, id);
    expect(await db.select().from(threads)).toEqual([]);

    sandbox.destroy = working.destroy;
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: ["sb-1"], errors: [] });
    quiet.mockRestore();
  });

  it("is paused later when pausing fails, unless the thread was woken or closed in the meantime", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, sandbox, alice, id, working, down, stopped, row } = await runningThread();
    sandbox.pause = down;

    expect((await pauseThread(ctx, alice.userId, id)).thread.status).toBe("paused");
    expect(await row()).toEqual({ status: "paused", sandboxId: "sb-1", runningSince: null });
    expect(stopped).toEqual(["sb-1:user"]);
    expect(await retryLeftoverSandboxes(ctx)).toMatchObject({ stopped: [], errors: [{ sandboxId: "sb-1" }] });

    sandbox.pause = working.pause;
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: ["sb-1"], errors: [] });
    expect(sandbox.calls.at(-1)).toBe("pause:sb-1");

    // Woken before the sweep came round: the sandbox is in use again and must be left running.
    sandbox.pause = down;
    await resumeThread(ctx, alice.userId, id);
    await pauseThread(ctx, alice.userId, id);
    await resumeThread(ctx, alice.userId, id);
    sandbox.pause = working.pause;
    const before = sandbox.calls.length;
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: [], errors: [] });
    expect(sandbox.calls).toHaveLength(before);

    // Closed before the sweep came round: closing removes it, so there is nothing to pause.
    sandbox.pause = down;
    await pauseThread(ctx, alice.userId, id);
    sandbox.pause = working.pause;
    await deleteThread(ctx, alice.userId, id);
    expect(sandbox.calls.at(-1)).toBe("destroy:sb-1");
    const after = sandbox.calls.length;
    expect(await retryLeftoverSandboxes(ctx)).toEqual({ stopped: [], errors: [] });
    expect(sandbox.calls).toHaveLength(after);
    quiet.mockRestore();
  });
});
