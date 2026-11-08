import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { automationRuns, threads, workspaceMembers } from "@lemonlime/db";
import type { CreateThreadRequest, ThreadEvent } from "@lemonlime/protocol";
import {
  AutomationPatch,
  createAutomation,
  listAutomationRuns,
  listAutomations,
  reviewAllRuns,
  runDueAutomations,
  setRunReviewed,
  updateAutomation,
} from "../src/lib/automations.ts";
import { appendHistory } from "../src/lib/history.ts";
import { closeInactiveThreads, createThread } from "../src/lib/threads.ts";
import { getWorkspaceSettings, getWorkspaceSkills, putWorkspaceSkills, updateWorkspaceSettings } from "../src/lib/workspace-settings.ts";
import { addUser, createTestApp } from "./helpers.ts";

const status = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: { status?: number }) => e.status ?? -1,
  );

const cloud: CreateThreadRequest = {
  agent: { kind: "claude-code" },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  mode: "cloud",
  sandboxSize: "small",
};

async function team() {
  const app = await createTestApp();
  const alice = await addUser(app.db, "alice@example.com");
  const bob = await addUser(app.db, "bob@example.com");
  // Bob is a member (not an owner) of Alice's workspace.
  await app.db.insert(workspaceMembers).values({ workspaceId: alice.workspaceId, userId: bob.userId, role: "member" });
  return { ...app, alice, bob };
}

describe("workspace settings", () => {
  it("start at the defaults, are read by members and changed by owners only", async () => {
    const { ctx, alice, bob } = await team();
    const initial = await getWorkspaceSettings(ctx, bob.userId, alice.workspaceId);
    expect(initial).toMatchObject({
      canEdit: false,
      settings: { instructions: "", setupScript: "", stripCoauthors: false, retryMaxWaitMinutes: 0, autoDeleteDays: null, skills: [], updatedAt: null },
    });
    expect(await status(updateWorkspaceSettings(ctx, bob.userId, alice.workspaceId, { instructions: "x" }))).toBe(403);
    const outsider = await addUser(ctx.db, "eve@example.com");
    expect(await status(getWorkspaceSettings(ctx, outsider.userId, alice.workspaceId))).toBe(403);

    await updateWorkspaceSettings(ctx, alice.userId, alice.workspaceId, { instructions: "Use pnpm.", stripCoauthors: true });
    const changed = await updateWorkspaceSettings(ctx, alice.userId, alice.workspaceId, { retryMaxWaitMinutes: 90 });
    // Fields left out stay as they were.
    expect(changed.settings).toMatchObject({ instructions: "Use pnpm.", stripCoauthors: true, retryMaxWaitMinutes: 90, autoDeleteDays: null });
    expect((await getWorkspaceSettings(ctx, alice.userId, alice.workspaceId)).canEdit).toBe(true);
  });

  it("keep the workspace's skills, listed by name and size", async () => {
    const { ctx, alice, bob } = await team();
    const skills = [{ name: "deploy", files: { "SKILL.md": "# Deploy", "run.sh": "echo" } }];
    expect(await status(putWorkspaceSkills(ctx, bob.userId, alice.workspaceId, skills))).toBe(403);
    const res = await putWorkspaceSkills(ctx, alice.userId, alice.workspaceId, skills);
    expect(res.settings.skills).toEqual([{ name: "deploy", fileCount: 2, bytes: 8 + 8 + 6 + 4 }]);
    expect(await getWorkspaceSkills(ctx, bob.userId, alice.workspaceId)).toEqual(skills);
    await putWorkspaceSkills(ctx, alice.userId, alice.workspaceId, []);
    expect((await getWorkspaceSettings(ctx, bob.userId, alice.workspaceId)).settings.skills).toEqual([]);
  });

  it("go into every new sandbox: instructions, trailers, retry, skills and the setup script", async () => {
    const { ctx, sandbox, alice } = await team();
    await createThread(ctx, alice.userId, alice.workspaceId, cloud);
    expect(sandbox.created[0]!.runner.env.LEMONLIME_INSTRUCTIONS).toBeUndefined();
    expect(sandbox.created[0]!.runner.setupScript).toBeUndefined();

    await updateWorkspaceSettings(ctx, alice.userId, alice.workspaceId, {
      instructions: "Write tests first.",
      setupScript: "npm i -g pnpm",
      stripCoauthors: true,
      retryMaxWaitMinutes: 120,
    });
    const skills = [{ name: "deploy", files: { "SKILL.md": "# Deploy" } }];
    await putWorkspaceSkills(ctx, alice.userId, alice.workspaceId, skills);
    await createThread(ctx, alice.userId, alice.workspaceId, cloud);
    const launch = sandbox.created[1]!.runner;
    expect(launch.env).toMatchObject({ LEMONLIME_INSTRUCTIONS: "Write tests first.", LEMONLIME_STRIP_COAUTHORS: "1", LEMONLIME_RETRY_MAX_WAIT: "120" });
    expect(launch.setupScript).toBe("npm i -g pnpm");
    expect(JSON.parse(gunzipSync(Buffer.from(launch.env.LEMONLIME_USER_SKILLS_0!, "base64")).toString("utf8"))).toEqual(skills);
    // None of it is a secret to hide from the agent's output.
    expect(launch.env.LEMONLIME_REDACT_ENV ?? "").not.toContain("LEMONLIME_INSTRUCTIONS");
  });

  it("close cloud threads idle longer than the workspace keeps them, and delete their sandboxes", async () => {
    const { ctx, db, sandbox, alice } = await team();
    const old = (await createThread(ctx, alice.userId, alice.workspaceId, cloud)).thread.id;
    const fresh = (await createThread(ctx, alice.userId, alice.workspaceId, cloud)).thread.id;
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await db.update(threads).set({ updatedAt: tenDaysAgo }).where(eq(threads.id, old));
    // Without the setting nothing is touched.
    expect((await closeInactiveThreads(ctx)).closed).toEqual([]);

    await updateWorkspaceSettings(ctx, alice.userId, alice.workspaceId, { autoDeleteDays: 7 });
    await db.update(threads).set({ updatedAt: tenDaysAgo }).where(eq(threads.id, old)); // saving touched nothing else, but be sure
    expect((await closeInactiveThreads(ctx)).closed).toEqual([old]);
    const [row] = await db.select().from(threads).where(eq(threads.id, old));
    expect(row).toMatchObject({ status: "stopped", sandboxId: null });
    expect(sandbox.calls).toContain("destroy:sb-1");
    expect((await db.select().from(threads).where(eq(threads.id, fresh)))[0]!.status).not.toBe("stopped");
    expect((await closeInactiveThreads(ctx)).closed).toEqual([]); // already closed
  });
});

describe("automation runs", () => {
  const input = {
    name: "Nightly",
    schedule: "0 3 * * *",
    timezone: "UTC",
    agent: { kind: "codex" as const },
    repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
    sandboxSize: "small" as const,
    prompt: "Tidy up.",
    enabled: true,
  };

  it("can be marked reviewed, one at a time or all at once, and show what the agent said", async () => {
    const { ctx, alice, bob } = await team();
    const a = await createAutomation(ctx, alice.userId, alice.workspaceId, input);
    await runDueAutomations(ctx, Date.parse(a.nextRunAt!) + 1000);
    const [run] = await listAutomationRuns(ctx, alice.userId, a.id);
    expect(run).toMatchObject({ status: "started", reviewedAt: null, summary: null, threadStatus: "provisioning" });

    // The agent's last whole message becomes the run's summary.
    const [thread] = await ctx.db.select().from(threads).where(eq(threads.id, run!.threadId!));
    const at = new Date().toISOString();
    const events: ThreadEvent[] = [
      { threadId: thread!.id, seq: 1, at, type: "agent_message", text: "Working on it", partial: false },
      { threadId: thread!.id, seq: 2, at, type: "agent_message", text: `Done:\n  updated ${"x".repeat(400)}`, partial: false },
      { threadId: thread!.id, seq: 3, at, type: "agent_message", text: "partial", partial: true },
    ] as ThreadEvent[];
    await appendHistory(ctx, thread!, events);
    const [listed] = await listAutomations(ctx, alice.workspaceId);
    const summary = listed!.recentRuns[0]!.summary!;
    expect(summary.startsWith("Done: updated xxx")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(280);

    // Any member may mark it; outsiders can't see it.
    expect((await setRunReviewed(ctx, bob.userId, a.id, run!.id, true)).reviewedAt).toBeTruthy();
    expect((await setRunReviewed(ctx, bob.userId, a.id, run!.id, false)).reviewedAt).toBeNull();
    const eve = await addUser(ctx.db, "eve@example.com");
    expect(await status(setRunReviewed(ctx, eve.userId, a.id, run!.id, true))).toBe(404);
    expect(await status(setRunReviewed(ctx, alice.userId, a.id, "no-such-run", true))).toBe(404);

    await runDueAutomations(ctx, Date.parse(a.nextRunAt!) + 86_400_000 + 1000);
    expect(await reviewAllRuns(ctx, alice.workspaceId)).toEqual({ reviewed: 2 });
    expect((await ctx.db.select().from(automationRuns)).every(r => r.reviewedAt)).toBe(true);
    expect(await reviewAllRuns(ctx, alice.workspaceId)).toEqual({ reviewed: 0 });
  });

  it("can have any of their fields edited", async () => {
    const { ctx, alice } = await team();
    const a = await createAutomation(ctx, alice.userId, alice.workspaceId, input);
    const patch = AutomationPatch.parse({
      name: "Weekly",
      schedule: "0 9 * * 1",
      timezone: "Europe/London",
      prompt: "Tidy up more.",
      agent: { kind: "claude-code", model: "opus" },
      repo: { url: "https://github.com/acme/other.git", baseBranch: "dev" },
      sandboxSize: "large",
    });
    const updated = await updateAutomation(ctx, alice.userId, a.id, patch);
    expect(updated).toMatchObject({ ...patch, enabled: true });
  });
});
