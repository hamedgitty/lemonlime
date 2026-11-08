import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { automationRuns, automations, threads } from "@lemonlime/db";
import {
  AGENT_CAPABILITIES,
  AgentConfig,
  automationPauseReason,
  CHECK_SCRIPT_MAX_CHARS,
  WEBHOOK_BODY_MAX_BYTES,
  isValidTimeZone,
  MAX_FAILURES_IN_A_ROW,
  nextRun,
  parseSchedule,
  promptWithContext,
  RepoRef,
  runOutcome,
  SandboxSize,
  webhookContext,
  type RunOutcome,
  type Thread,
} from "@lemonlime/protocol";
import { userWorkspaceIds } from "./access.ts";
import { safeEqual } from "./access-tokens.ts";
import type { AppContext } from "./context.ts";
import { HttpError, PolicyDeniedError } from "./errors.ts";
import { enforce } from "./rate-limit.ts";
import { addPendingMessage, threadEnding } from "./history.ts";
import { validateCloudLaunch } from "./runner-command.ts";
import { createThread, endRun, getThreadRow } from "./threads.ts";

/** A five-field cron, or empty for an automation that only runs from its webhook. */
const ScheduleText = z
  .string()
  .trim()
  .max(120)
  .refine(s => s === "" || s.length >= 9, "A schedule has five parts, e.g. 0 9 * * 1-5.");

export const AutomationInput = z.object({
  name: z.string().trim().min(1).max(120),
  schedule: ScheduleText,
  timezone: z.string().trim().max(64).default("UTC"),
  agent: AgentConfig,
  repo: RepoRef,
  sandboxSize: SandboxSize.default("small"),
  prompt: z.string().trim().min(1).max(50_000),
  checkScript: z.string().trim().max(CHECK_SCRIPT_MAX_CHARS).default(""),
  enabled: z.boolean().default(true),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

/** A change to an automation: only the fields given (no defaults, so nothing else is reset). */
export const AutomationPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    schedule: ScheduleText,
    timezone: z.string().trim().max(64),
    agent: AgentConfig,
    repo: RepoRef,
    sandboxSize: SandboxSize,
    prompt: z.string().trim().min(1).max(50_000),
    checkScript: z.string().trim().max(CHECK_SCRIPT_MAX_CHARS),
    enabled: z.boolean(),
  })
  .partial();
export type AutomationPatch = z.infer<typeof AutomationPatch>;

/** Checked when an automation is saved, so a bad one fails now rather than at 3am. */
export function validateAutomation(input: AutomationInput): void {
  if (input.schedule) {
    try {
      parseSchedule(input.schedule);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
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
  if (input.schedule && !nextRun(input.schedule, new Date(), input.timezone)) throw new HttpError(400, "That schedule never comes round.");
}

const next = (schedule: string, timezone: string, after: Date) => (schedule ? (nextRun(schedule, after, timezone)?.toISOString() ?? null) : null);

type AutomationRow = typeof automations.$inferSelect;
/** An automation as clients see it: never the webhook's secret (or its hash), only whether it has one. */
export type PublicAutomation = Omit<AutomationRow, "webhookTokenHash"> & { hasWebhook: boolean };

export function publicAutomation(row: AutomationRow): PublicAutomation {
  const { webhookTokenHash, ...rest } = row;
  return { ...rest, hasWebhook: Boolean(webhookTokenHash) };
}

export async function createAutomation(
  ctx: AppContext,
  userId: string,
  workspaceId: string,
  given: Omit<AutomationInput, "checkScript"> & { checkScript?: string },
): Promise<PublicAutomation> {
  const input: AutomationInput = { ...given, checkScript: given.checkScript?.trim() ?? "" };
  validateAutomation(input);
  const [row] = await ctx.db
    .insert(automations)
    .values({ ...input, workspaceId, createdBy: userId, nextRunAt: input.enabled ? next(input.schedule, input.timezone, new Date()) : null })
    .returning();
  return publicAutomation(row!);
}

async function ownAutomation(ctx: AppContext, userId: string, id: string) {
  const [row] = await ctx.db.select().from(automations).where(eq(automations.id, id));
  if (!row || !(await userWorkspaceIds(ctx.db, userId)).includes(row.workspaceId)) throw new HttpError(404, "Automation not found.");
  return row;
}

export async function updateAutomation(ctx: AppContext, userId: string, id: string, patch: AutomationPatch): Promise<PublicAutomation> {
  const row = await ownAutomation(ctx, userId, id);
  const merged = AutomationInput.parse({ ...row, ...patch });
  validateAutomation(merged);
  // Turning it back on starts the count of failures afresh; any change clears why it stopped
  // itself once it's on again, and pausing by hand needs no reason.
  const resumed = merged.enabled && !row.enabled;
  const [updated] = await ctx.db
    .update(automations)
    .set({
      ...merged,
      nextRunAt: merged.enabled ? next(merged.schedule, merged.timezone, new Date()) : null,
      ...(resumed ? { resumedAt: new Date().toISOString(), pausedReason: null } : {}),
      ...(patch.enabled === false ? { pausedReason: null } : {}),
    })
    .where(eq(automations.id, id))
    .returning();
  return publicAutomation(updated!);
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

const WEBHOOK_TOKEN_PREFIX = "llhook_";
const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Where a webhook is called: the automation's id and its secret, in the path. */
export const webhookPath = (id: string, token: string) => `/api/automations/${encodeURIComponent(id)}/webhook/${token}`;

/**
 * Give an automation a new webhook secret (replacing any old one, which stops working at
 * once) and return it. It is shown this once; only its hash is kept.
 */
export async function rotateWebhook(ctx: AppContext, userId: string, id: string): Promise<{ token: string; path: string }> {
  await ownAutomation(ctx, userId, id);
  const token = WEBHOOK_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  await ctx.db
    .update(automations)
    .set({ webhookTokenHash: hashToken(token) })
    .where(eq(automations.id, id));
  return { token, path: webhookPath(id, token) };
}

export async function removeWebhook(ctx: AppContext, userId: string, id: string): Promise<void> {
  await ownAutomation(ctx, userId, id);
  await ctx.db.update(automations).set({ webhookTokenHash: null }).where(eq(automations.id, id));
}

/** Webhook calls one automation accepts, and calls one address may make, before a 429. */
export const WEBHOOK_LIMITS = {
  perAutomation: { max: 30, windowSeconds: 60 * 60 },
  perAddress: { max: 60, windowSeconds: 60 },
};

/** A webhook request's body as text, refused (413) when it's bigger than the agent should be given. */
export async function readWebhookBody(request: Request): Promise<string> {
  const tooBig = () => new HttpError(413, `The body can be at most ${WEBHOOK_BODY_MAX_BYTES / 1024} KB.`);
  if (Number(request.headers.get("content-length") ?? 0) > WEBHOOK_BODY_MAX_BYTES) throw tooBig();
  if (!request.body) return "";
  // Read in pieces and stop early, so a body without a length can't be huge either.
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEBHOOK_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * A call to an automation's webhook: check the secret (in constant time, against its hash),
 * then start a run with the request body as context. A wrong secret and a missing
 * automation look the same from outside.
 */
export async function triggerWebhook(ctx: AppContext, id: string, token: string, body: string): Promise<{ status: RunRow["status"]; threadId: string | null }> {
  const [row] = await ctx.db.select().from(automations).where(eq(automations.id, id));
  // Compare even when there is nothing to compare against, so a missing automation takes as long.
  const ok = safeEqual(hashToken(token), row?.webhookTokenHash ?? hashToken(`missing:${token}`)) && Boolean(row?.webhookTokenHash);
  if (!row || !ok) throw new HttpError(404, "No webhook here.");
  // Counted only once the secret is right, so strangers can't use up an automation's calls.
  await enforce(ctx.db, `automation-hook:${row.id}`, WEBHOOK_LIMITS.perAutomation, "webhook calls for this automation");
  if (!row.enabled) throw new HttpError(409, row.pausedReason ? `This automation is paused: ${row.pausedReason}` : "This automation is paused.");
  if (await pauseIfFailing(ctx, row)) throw new HttpError(409, "This automation just paused itself; open it in LemonLime to see why.");
  const context = webhookContext(body);
  const run = await startRun(ctx, row, { scheduledFor: new Date().toISOString(), trigger: "webhook", context: context ? [context] : [] });
  return run;
}

export async function deleteAutomation(ctx: AppContext, userId: string, id: string): Promise<void> {
  await ownAutomation(ctx, userId, id);
  await ctx.db.delete(automations).where(eq(automations.id, id));
}

/** Longest summary shown for a run: the start of the agent's last message. */
const SUMMARY_CHARS = 280;

export function summarize(text: string, max = SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

type RunRow = typeof automationRuns.$inferSelect;
/** A run as listings show it: how its thread is doing, what the agent said last, and what it came to. */
export type RunWithResult = RunRow & { threadStatus: Thread["status"] | null; summary: string | null; outcome: RunOutcome; errorCode: string | null };

async function withResults(ctx: AppContext, runs: RunRow[]): Promise<RunWithResult[]> {
  const ids = [
    ...new Set(
      runs
        .filter(r => r.status === "started")
        .map(r => r.threadId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const statuses = new Map<string, Thread["status"]>();
  if (ids.length) {
    for (const t of await ctx.db.select({ id: threads.id, status: threads.status }).from(threads).where(inArray(threads.id, ids))) statuses.set(t.id, t.status);
  }
  const endings = new Map<string, { message: string | null; errorCode: string | null }>();
  await Promise.all(
    ids.map(async id => {
      endings.set(id, await threadEnding(ctx, id).catch(() => ({ message: null, errorCode: null })));
    }),
  );
  return runs.map(r => {
    const threadStatus = r.threadId ? (statuses.get(r.threadId) ?? null) : null;
    const ending = r.threadId ? endings.get(r.threadId) : undefined;
    const errorCode = ending?.errorCode ?? null;
    return {
      ...r,
      threadStatus,
      // Skipped and failed runs say why in `detail`.
      summary: ending?.message ? summarize(ending.message) : null,
      outcome: runOutcome({ status: r.status, threadStatus, errorCode, answered: Boolean(ending?.message) }),
      errorCode,
    };
  });
}

/** Mark one run as looked at, or not. Any member of the automation's workspace may. */
export async function setRunReviewed(ctx: AppContext, userId: string, automationId: string, runId: string, reviewed: boolean): Promise<RunWithResult> {
  await ownAutomation(ctx, userId, automationId);
  const [row] = await ctx.db
    .update(automationRuns)
    .set({ reviewedAt: reviewed ? new Date().toISOString() : null })
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.automationId, automationId)))
    .returning();
  if (!row) throw new HttpError(404, "Run not found.");
  return (await withResults(ctx, [row]))[0]!;
}

/** Mark every run of the workspace's automations not yet looked at as reviewed. The caller checked membership. */
export async function reviewAllRuns(ctx: AppContext, workspaceId: string): Promise<{ reviewed: number }> {
  const ids = (await ctx.db.select({ id: automations.id }).from(automations).where(eq(automations.workspaceId, workspaceId))).map(a => a.id);
  if (!ids.length) return { reviewed: 0 };
  const updated = await ctx.db
    .update(automationRuns)
    .set({ reviewedAt: new Date().toISOString() })
    .where(and(inArray(automationRuns.automationId, ids), isNull(automationRuns.reviewedAt)))
    .returning({ id: automationRuns.id });
  return { reviewed: updated.length };
}

export async function listAutomations(ctx: AppContext, workspaceId: string): Promise<(PublicAutomation & { recentRuns: RunWithResult[] })[]> {
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
  const recent = await withResults(
    ctx,
    rows.flatMap(r => runs.filter(x => x.automationId === r.id).slice(0, 5)),
  );
  return rows.map(r => ({ ...publicAutomation(r), recentRuns: recent.filter(x => x.automationId === r.id) }));
}

export async function listAutomationRuns(ctx: AppContext, userId: string, id: string, limit = 50): Promise<RunWithResult[]> {
  await ownAutomation(ctx, userId, id);
  const runs = await ctx.db.select().from(automationRuns).where(eq(automationRuns.automationId, id)).orderBy(desc(automationRuns.ranAt)).limit(limit);
  return withResults(ctx, runs);
}

export interface AutomationSweep {
  started: string[];
  skipped: string[];
  failed: string[];
  /** Turned off because they kept failing or the agent needs signing in. */
  paused?: string[];
}

/**
 * Turn an automation off when its recent runs say every next one would fail too: the
 * agent isn't signed in, or it failed three times in a row since it was last turned on.
 * Returns whether it was paused.
 */
export async function pauseIfFailing(ctx: AppContext, a: AutomationRow): Promise<boolean> {
  const conditions = [eq(automationRuns.automationId, a.id)];
  if (a.resumedAt) conditions.push(gt(automationRuns.ranAt, a.resumedAt));
  const runs = await ctx.db
    .select()
    .from(automationRuns)
    .where(and(...conditions))
    .orderBy(desc(automationRuns.ranAt))
    .limit(MAX_FAILURES_IN_A_ROW);
  const reason = automationPauseReason(await withResults(ctx, runs));
  if (!reason) return false;
  await ctx.db.update(automations).set({ enabled: false, nextRunAt: null, pausedReason: reason }).where(eq(automations.id, a.id));
  return true;
}

/**
 * Start one run of an automation: a new cloud thread whose prompt waits in its inbox (the
 * runner picks it up when it starts), with the check script, if any, to run first. Records
 * the run whatever happens.
 */
async function startRun(
  ctx: AppContext,
  a: AutomationRow,
  opts: { scheduledFor: string; trigger: "schedule" | "webhook"; context?: string[] },
): Promise<{ status: RunRow["status"]; threadId: string | null }> {
  const record = async (status: RunRow["status"], extra: { threadId?: string; detail?: string } = {}) => {
    await ctx.db.insert(automationRuns).values({ automationId: a.id, scheduledFor: opts.scheduledFor, status, trigger: opts.trigger, ...extra });
    return { status, threadId: extra.threadId ?? null };
  };
  if (!a.createdBy) return record("failed", { detail: "The person who set this up no longer has an account." });
  try {
    const { thread } = await createThread(ctx, a.createdBy, a.workspaceId, {
      title: a.name,
      agent: a.agent,
      repo: a.repo,
      mode: "cloud",
      sandboxSize: a.sandboxSize,
    });
    await addPendingMessage(ctx, thread.id, {
      clientMsgId: `automation-${a.id}-${opts.trigger === "webhook" ? `hook-${crypto.randomUUID()}` : opts.scheduledFor}`,
      text: promptWithContext(a.prompt, opts.context ?? []),
      ...(a.checkScript.trim() ? { check: a.checkScript } : {}),
    });
    return await record("started", { threadId: thread.id });
  } catch (err) {
    if (err instanceof PolicyDeniedError) return record("skipped", { detail: err.message });
    return record("failed", { detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The runner ran a run's check script and it said there was nothing to do: the run is
 * recorded as skipped, with why, and its sandbox deleted (it has nothing to keep).
 */
export async function recordCheckSkips(ctx: AppContext, threadId: string, skipped: readonly { clientMsgId: string; reason: string }[]): Promise<void> {
  const ours = skipped.filter(s => s.clientMsgId.startsWith("automation-"));
  if (!ours.length) return;
  await ctx.db
    .update(automationRuns)
    .set({ status: "skipped", detail: ours[0]!.reason.slice(0, 2000) })
    .where(and(eq(automationRuns.threadId, threadId), eq(automationRuns.status, "started")));
  const row = await getThreadRow(ctx, threadId);
  if (row && row.mode === "cloud" && row.status !== "stopped") {
    await endRun(ctx, row, "idle", { destroy: true }).catch(err => console.error("[lemonlime] could not stop a skipped automation's sandbox:", err));
  }
}

/**
 * Start every automation that is due, from the minute sweep. Each one is claimed by moving
 * its next run forward first, so two sweeps at once never start it twice. When the usage
 * policy says no (a plan limit, say), that run is recorded as skipped and the automation
 * stays on for next time. One that keeps failing turns itself off instead of starting.
 */
export async function runDueAutomations(ctx: AppContext, nowMs: number = Date.now()): Promise<AutomationSweep> {
  const now = new Date(nowMs);
  const due = await ctx.db
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), isNotNull(automations.nextRunAt), lte(automations.nextRunAt, now.toISOString())))
    .limit(25);
  const out: AutomationSweep = { started: [], skipped: [], failed: [], paused: [] };
  for (const a of due) {
    const following = next(a.schedule, a.timezone, now);
    const claimed = await ctx.db
      .update(automations)
      .set({ nextRunAt: following, lastRunAt: now.toISOString() })
      .where(and(eq(automations.id, a.id), eq(automations.nextRunAt, a.nextRunAt!)))
      .returning({ id: automations.id });
    if (!claimed.length) continue;
    if (await pauseIfFailing(ctx, a)) {
      out.paused!.push(a.id);
      continue;
    }
    const run = await startRun(ctx, a, { scheduledFor: a.nextRunAt!, trigger: "schedule" });
    out[run.status].push(a.id);
  }
  if (!out.paused!.length) delete out.paused;
  return out;
}
