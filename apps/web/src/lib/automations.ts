import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { automationRuns, automations } from "@lemonlime/db";
import { AGENT_CAPABILITIES, AgentConfig, isValidTimeZone, nextRun, parseSchedule, RepoRef, SandboxSize } from "@lemonlime/protocol";
import { userWorkspaceIds } from "./access.ts";
import type { AppContext } from "./context.ts";
import { HttpError, PolicyDeniedError } from "./errors.ts";
import { addPendingMessage } from "./history.ts";
import { validateCloudLaunch } from "./runner-command.ts";
import { createThread } from "./threads.ts";

export const AutomationInput = z.object({
  name: z.string().trim().min(1).max(120),
  schedule: z.string().trim().min(9).max(120),
  timezone: z.string().trim().max(64).default("UTC"),
  agent: AgentConfig,
  repo: RepoRef,
  sandboxSize: SandboxSize.default("small"),
  prompt: z.string().trim().min(1).max(50_000),
  enabled: z.boolean().default(true),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

/** A change to an automation: only the fields given (no defaults, so nothing else is reset). */
export const AutomationPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    schedule: z.string().trim().min(9).max(120),
    timezone: z.string().trim().max(64),
    agent: AgentConfig,
    repo: RepoRef,
    sandboxSize: SandboxSize,
    prompt: z.string().trim().min(1).max(50_000),
    enabled: z.boolean(),
  })
  .partial();
export type AutomationPatch = z.infer<typeof AutomationPatch>;

/** Checked when an automation is saved, so a bad one fails now rather than at 3am. */
export function validateAutomation(input: AutomationInput): void {
  try {
    parseSchedule(input.schedule);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  if (!isValidTimeZone(input.timezone)) throw new HttpError(400, `"${input.timezone}" isn't a time zone LemonLime knows, e.g. Europe/London.`);
  const caps = AGENT_CAPABILITIES[input.agent.kind];
  const model = input.agent.model;
  if (model && !/^[A-Za-z0-9][\w.:/-]{0,79}$/.test(model)) throw new HttpError(400, "That model name has characters agents don't accept.");
  if (input.agent.reasoning && !caps.reasoning.includes(input.agent.reasoning)) {
    throw new HttpError(
      400,
      caps.reasoning.length ? `This agent's thinking levels are ${caps.reasoning.join(", ")}.` : "This agent has no thinking levels to choose.",
    );
  }
  const invalid = validateCloudLaunch(input.agent, input.repo);
  if (invalid) throw new HttpError(400, invalid);
  if (!nextRun(input.schedule, new Date(), input.timezone)) throw new HttpError(400, "That schedule never comes round.");
}

const next = (schedule: string, timezone: string, after: Date) => nextRun(schedule, after, timezone)?.toISOString() ?? null;

export async function createAutomation(ctx: AppContext, userId: string, workspaceId: string, input: AutomationInput) {
  validateAutomation(input);
  const [row] = await ctx.db
    .insert(automations)
    .values({ ...input, workspaceId, createdBy: userId, nextRunAt: input.enabled ? next(input.schedule, input.timezone, new Date()) : null })
    .returning();
  return row!;
}

async function ownAutomation(ctx: AppContext, userId: string, id: string) {
  const [row] = await ctx.db.select().from(automations).where(eq(automations.id, id));
  if (!row || !(await userWorkspaceIds(ctx.db, userId)).includes(row.workspaceId)) throw new HttpError(404, "Automation not found.");
  return row;
}

export async function updateAutomation(ctx: AppContext, userId: string, id: string, patch: AutomationPatch) {
  const row = await ownAutomation(ctx, userId, id);
  const merged = AutomationInput.parse({ ...row, ...patch });
  validateAutomation(merged);
  const [updated] = await ctx.db
    .update(automations)
    .set({ ...merged, nextRunAt: merged.enabled ? next(merged.schedule, merged.timezone, new Date()) : null })
    .where(eq(automations.id, id))
    .returning();
  return updated!;
}

export async function deleteAutomation(ctx: AppContext, userId: string, id: string): Promise<void> {
  await ownAutomation(ctx, userId, id);
  await ctx.db.delete(automations).where(eq(automations.id, id));
}

export async function listAutomations(ctx: AppContext, workspaceId: string) {
  const rows = await ctx.db.select().from(automations).where(eq(automations.workspaceId, workspaceId)).orderBy(automations.createdAt);
  if (!rows.length) return [];
  const runs = await ctx.db
    .select()
    .from(automationRuns)
    .where(
      inArray(
        automationRuns.automationId,
        rows.map(r => r.id),
      ),
    )
    .orderBy(desc(automationRuns.ranAt))
    .limit(rows.length * 5);
  return rows.map(r => ({ ...r, recentRuns: runs.filter(x => x.automationId === r.id).slice(0, 5) }));
}

export async function listAutomationRuns(ctx: AppContext, userId: string, id: string, limit = 50) {
  await ownAutomation(ctx, userId, id);
  return ctx.db.select().from(automationRuns).where(eq(automationRuns.automationId, id)).orderBy(desc(automationRuns.ranAt)).limit(limit);
}

export interface AutomationSweep {
  started: string[];
  skipped: string[];
  failed: string[];
}

/**
 * Start every automation that is due, from the minute sweep. Each one is claimed by moving
 * its next run forward first, so two sweeps at once never start it twice. When the usage
 * policy says no (a plan limit, say), that run is recorded as skipped and the automation
 * stays on for next time.
 */
export async function runDueAutomations(ctx: AppContext, nowMs: number = Date.now()): Promise<AutomationSweep> {
  const now = new Date(nowMs);
  const due = await ctx.db
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), isNotNull(automations.nextRunAt), lte(automations.nextRunAt, now.toISOString())))
    .limit(25);
  const out: AutomationSweep = { started: [], skipped: [], failed: [] };
  for (const a of due) {
    const following = next(a.schedule, a.timezone, now);
    const claimed = await ctx.db
      .update(automations)
      .set({ nextRunAt: following, lastRunAt: now.toISOString() })
      .where(and(eq(automations.id, a.id), eq(automations.nextRunAt, a.nextRunAt!)))
      .returning({ id: automations.id });
    if (!claimed.length) continue;
    const record = (status: "started" | "skipped" | "failed", extra: { threadId?: string; detail?: string } = {}) =>
      ctx.db.insert(automationRuns).values({ automationId: a.id, scheduledFor: a.nextRunAt!, status, ...extra });
    if (!a.createdBy) {
      await record("failed", { detail: "The person who set this up no longer has an account." });
      out.failed.push(a.id);
      continue;
    }
    try {
      const { thread } = await createThread(ctx, a.createdBy, a.workspaceId, {
        title: a.name,
        agent: a.agent,
        repo: a.repo,
        mode: "cloud",
        sandboxSize: a.sandboxSize,
      });
      // Nobody is watching, so the prompt waits in the thread's inbox; the runner picks it up when it starts.
      await addPendingMessage(ctx, thread.id, { clientMsgId: `automation-${a.id}-${a.nextRunAt}`, text: a.prompt });
      await record("started", { threadId: thread.id });
      out.started.push(a.id);
    } catch (err) {
      if (err instanceof PolicyDeniedError) {
        await record("skipped", { detail: err.message });
        out.skipped.push(a.id);
      } else {
        await record("failed", { detail: err instanceof Error ? err.message : String(err) });
        out.failed.push(a.id);
      }
    }
  }
  return out;
}
