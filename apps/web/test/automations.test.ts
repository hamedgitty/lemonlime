import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automations, pendingMessages, threads } from "@lemonlime/db";
import { AutomationPatch, createAutomation, listAutomations, runDueAutomations, updateAutomation, type AutomationInput } from "../src/lib/automations.ts";
import { addUser, createTestApp } from "./helpers.ts";

const input: AutomationInput = {
  name: "Nightly dependency bump",
  schedule: "0 3 * * *",
  timezone: "UTC",
  agent: { kind: "codex", model: "gpt-6-astra", reasoning: "medium" },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  sandboxSize: "small",
  prompt: "Update dependencies and open a pull request.",
  enabled: true,
};
const status = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: { status?: number }) => e.status ?? -1,
  );

describe("automations", () => {
  it("check what they're given when saved", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    expect(await status(createAutomation(ctx, alice.userId, alice.workspaceId, { ...input, schedule: "every night" }))).toBe(400);
    expect(await status(createAutomation(ctx, alice.userId, alice.workspaceId, { ...input, timezone: "Mars/Base" }))).toBe(400);
    expect(await status(createAutomation(ctx, alice.userId, alice.workspaceId, { ...input, agent: { kind: "opencode", reasoning: "high" } }))).toBe(400);
    expect(await status(createAutomation(ctx, alice.userId, alice.workspaceId, { ...input, agent: { kind: "codex", model: "x; rm -rf /" } }))).toBe(400);
    const a = await createAutomation(ctx, alice.userId, alice.workspaceId, input);
    expect(a.nextRunAt).toMatch(/T03:00:00.000Z$/);
  });

  it("start a cloud thread with the prompt waiting for its runner, once per due time", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const a = await createAutomation(ctx, alice.userId, alice.workspaceId, input);
    const due = Date.parse(a.nextRunAt!) + 30_000;
    const [first, second] = await Promise.all([runDueAutomations(ctx, due), runDueAutomations(ctx, due)]);
    expect([...first.started, ...second.started]).toEqual([a.id]); // never twice
    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({ mode: "cloud", title: "Nightly dependency bump", workspaceId: alice.workspaceId });
    expect((await db.select().from(pendingMessages).where(eq(pendingMessages.threadId, thread!.id))).map(m => m.text)).toEqual([input.prompt]);
    const [row] = await db.select().from(automations);
    expect(Date.parse(row!.nextRunAt!) - Date.parse(a.nextRunAt!)).toBe(24 * 3600_000);
    const [listed] = await listAutomations(ctx, alice.workspaceId);
    expect(listed!.recentRuns).toMatchObject([{ status: "started", threadId: thread!.id }]);
  });

  it("are skipped, not turned off, when the plan says no", async () => {
    const { ctx, db } = await createTestApp({ policy: { canStartSandbox: async () => ({ allow: false, reason: "You're out of cloud hours." }) } });
    const alice = await addUser(db, "alice@example.com");
    const a = await createAutomation(ctx, alice.userId, alice.workspaceId, input);
    const result = await runDueAutomations(ctx, Date.parse(a.nextRunAt!) + 1000);
    expect(result).toEqual({ started: [], skipped: [a.id], failed: [] });
    const [listed] = await listAutomations(ctx, alice.workspaceId);
    expect(listed).toMatchObject({ enabled: true, recentRuns: [{ status: "skipped", detail: "You're out of cloud hours." }] });
    expect(listed!.nextRunAt).not.toBe(a.nextRunAt);
  });

  it("can be paused, and only by members of their workspace", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const bob = await addUser(db, "bob@example.com");
    const a = await createAutomation(ctx, alice.userId, alice.workspaceId, input);
    expect(await status(updateAutomation(ctx, bob.userId, a.id, { enabled: false }))).toBe(404);
    const london = await createAutomation(ctx, alice.userId, alice.workspaceId, { ...input, timezone: "Europe/London", sandboxSize: "large" });
    // Pausing changes only that: the time zone and size stay as they were.
    const paused = await updateAutomation(ctx, alice.userId, london.id, AutomationPatch.parse({ enabled: false }));
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null, timezone: "Europe/London", sandboxSize: "large" });
    expect((await updateAutomation(ctx, alice.userId, a.id, { enabled: false })).nextRunAt).toBeNull();
    expect(await runDueAutomations(ctx, Date.now() + 2 * 86_400_000)).toEqual({ started: [], skipped: [], failed: [] });
  });
});
