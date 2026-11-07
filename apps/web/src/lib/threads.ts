import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  Thread,
  branchForThread,
  newThreadId,
  type CreateThreadRequest,
  type RunnerEndpoint,
  type RunnerHeartbeat,
  type HeartbeatResponse,
  type ThreadWithEndpoint,
} from "@lemonlime/protocol";
import type { RunningSandbox } from "@lemonlime/plugins";
import { runnerWsUrl } from "@lemonlime/sandbox";
import { sandboxRuns, threads, type ThreadRow } from "@lemonlime/db";
import { getThreadForUser, listThreadsForUser } from "./access.ts";
import type { AppContext } from "./context.ts";
import { HttpError, PolicyDeniedError } from "./errors.ts";
import { countPendingMessages } from "./history.ts";
import { secretsForSandbox } from "./secrets.ts";
import { RUNNER_PORT, buildRunnerLaunch, validateCloudLaunch } from "./runner-command.ts";
import { decideSweep, runtimeSeconds, type EndReason, type SweepThread } from "./sweep.ts";
import { issueClientToken, threadSecret } from "./tokens.ts";

export type { ThreadRow };

/** Response for one thread: the protocol shape plus the first prompt, if the thread has one. */
export type ThreadResponse = ThreadWithEndpoint & { initialPrompt: string | null; pullRequestUrl: string | null };

const iso = (value: string): string => new Date(value).toISOString();
const isoOrNull = (value: string | null): string | null => (value ? iso(value) : null);

export function rowToThread(row: ThreadRow): Thread {
  return Thread.parse({
    id: row.id,
    title: row.title,
    agent: row.agent,
    repo: row.repo,
    branch: row.branch,
    mode: row.mode,
    status: row.status,
    sandboxSize: row.sandboxSize,
    latestSeq: row.latestSeq,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
}

function toSweepThread(row: ThreadRow): SweepThread & { row: ThreadRow } {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    sandboxId: row.sandboxId,
    idleSince: isoOrNull(row.idleSince),
    runningSince: isoOrNull(row.runningSince),
    lastHeartbeatAt: isoOrNull(row.lastHeartbeatAt),
    background: row.background,
    drainRequestedAt: isoOrNull(row.drainRequestedAt),
    drainedAt: isoOrNull(row.drainedAt),
    row,
  };
}

function runningSandbox(row: ThreadRow): RunningSandbox {
  return {
    userId: row.createdBy ?? "",
    workspaceId: row.workspaceId,
    threadId: row.id,
    size: row.sandboxSize,
    sandboxId: row.sandboxId ?? "",
    runningSince: iso(row.runningSince ?? row.updatedAt),
  };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** A thread row by id, without an access check (for runner-authenticated routes). */
export function getThreadRow(ctx: AppContext, id: string): Promise<ThreadRow | null> {
  return getRow(ctx, id);
}

async function getRow(ctx: AppContext, id: string): Promise<ThreadRow | null> {
  return (await ctx.db.select().from(threads).where(eq(threads.id, id)).get()) ?? null;
}

/** The thread, if the user is a member of its workspace; otherwise 404. */
export function getThreadRowForUser(ctx: AppContext, userId: string, id: string): Promise<ThreadRow> {
  return getThreadForUser(ctx.db, userId, id);
}

/** Threads in a workspace the user belongs to (403 otherwise). */
export async function listThreads(ctx: AppContext, userId: string, workspaceId: string, limit = 200): Promise<Thread[]> {
  return (await listThreadsForUser(ctx.db, userId, workspaceId, limit)).map(rowToThread);
}

const LIVE_STATUSES = new Set<Thread["status"]>(["provisioning", "idle", "running"]);

/** A fresh WebSocket endpoint and client token, when the thread's cloud runner is reachable. */
export async function endpointFor(ctx: AppContext, row: ThreadRow, userId: string): Promise<RunnerEndpoint | null> {
  if (row.mode !== "cloud" || !row.runnerUrl || !row.runningSince || !LIVE_STATUSES.has(row.status)) return null;
  const { token, expiresAt } = await issueClientToken({ masterSecret: ctx.config.tokenSecret(), threadId: row.id, userId });
  return { url: runnerWsUrl(row.runnerUrl), token, expiresAt };
}

export async function threadResponse(ctx: AppContext, row: ThreadRow, userId: string): Promise<ThreadResponse> {
  return { thread: rowToThread(row), endpoint: await endpointFor(ctx, row, userId), initialPrompt: row.initialPrompt, pullRequestUrl: row.pullRequestUrl };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * How to start a thread's runner. Secrets are only added for a new sandbox: providers keep
 * a sandbox's environment across pauses, and changing a secret applies to new threads.
 */
async function launchFor(ctx: AppContext, row: Pick<ThreadRow, "id" | "agent" | "repo" | "workspaceId">, opts: { withSecrets?: boolean } = {}) {
  return buildRunnerLaunch({
    threadId: row.id,
    agent: row.agent,
    repo: row.repo,
    controlPlaneUrl: ctx.config.runnerControlPlaneUrl(),
    threadSecret: await threadSecret(ctx.config.tokenSecret(), row.id),
    ...(opts.withSecrets ? { secrets: await secretsForSandbox(ctx, row.workspaceId) } : {}),
  });
}

type ThreadPatch = Partial<Omit<ThreadRow, "id" | "workspaceId" | "createdAt" | "updatedAt">>;

async function updateRow(ctx: AppContext, id: string, patch: ThreadPatch): Promise<ThreadRow> {
  const [row] = await ctx.db.update(threads).set(patch).where(eq(threads.id, id)).returning();
  if (!row) throw new HttpError(404, "Thread not found.");
  return row;
}

/** Tell the plugin about a start/stop without letting a failing hook break the request. */
async function notify(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[lemonlime] usage policy ${what} hook failed:`, err);
  }
}

/**
 * Create a thread in a workspace the caller has already been checked against
 * (`resolveWorkspace`). Cloud threads get a sandbox (after the usage policy
 * agrees); local ones are metadata only.
 */
export async function createThread(ctx: AppContext, userId: string, workspaceId: string, req: CreateThreadRequest): Promise<ThreadResponse> {
  const id = newThreadId();
  const base = {
    id,
    workspaceId,
    createdBy: userId,
    title: req.title?.trim() || defaultTitle(req),
    agent: req.agent,
    repo: req.repo,
    branch: branchForThread(id),
    mode: req.mode,
    sandboxSize: req.sandboxSize,
    initialPrompt: req.prompt?.trim() || null,
  };

  if (req.mode === "local") {
    // The desktop app runs the runner itself; the control plane only keeps the record.
    const [row] = await ctx.db
      .insert(threads)
      .values({ ...base, status: "idle" })
      .returning();
    return threadResponse(ctx, row!, userId);
  }

  const invalid = validateCloudLaunch(req.agent, req.repo);
  if (invalid) throw new HttpError(400, invalid);

  const { usagePolicy } = ctx.plugin;
  const decision = await usagePolicy.canStartSandbox({ userId, workspaceId, threadId: id, size: req.sandboxSize });
  if (!decision.allow) throw new PolicyDeniedError(decision);

  const provider = ctx.sandbox();
  const [inserted] = await ctx.db
    .insert(threads)
    .values({ ...base, status: "provisioning", sandboxProvider: provider.name })
    .returning();

  const launch = await launchFor(ctx, inserted!, { withSecrets: true });
  let info;
  try {
    info = await provider.create({
      threadId: id,
      size: req.sandboxSize,
      runner: launch,
      labels: { "lemonlime.workspace": workspaceId, "lemonlime.runner-port": String(RUNNER_PORT) },
    });
  } catch (err) {
    await updateRow(ctx, id, { status: "failed" });
    throw new HttpError(502, `Could not start the sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = new Date().toISOString();
  const row = await updateRow(ctx, id, {
    sandboxId: info.id,
    runnerUrl: info.runnerUrl,
    runningSince: now,
    idleSince: now,
    lastHeartbeatAt: null,
  });
  await notify("onSandboxStarted", () => usagePolicy.onSandboxStarted(runningSandbox(row)));
  return threadResponse(ctx, row, userId);
}

function defaultTitle(req: CreateThreadRequest): string {
  const firstLine = req.prompt?.trim().split("\n")[0]?.trim();
  if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  const repo =
    req.repo.url
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? "repo";
  return `${req.agent.kind} on ${repo}`;
}

/**
 * End the thread's current run: pause or destroy the sandbox, then record the run
 * exactly once (the conditional update on `running_since` makes this idempotent).
 */
export async function endRun(
  ctx: AppContext,
  row: ThreadRow,
  endReason: EndReason,
  opts: { destroy?: boolean; status?: Thread["status"] } = {},
): Promise<ThreadRow> {
  if (row.sandboxId) {
    const provider = ctx.sandbox();
    if (opts.destroy) await provider.destroy(row.sandboxId);
    else await provider.pause(row.sandboxId);
  }

  const status = opts.status ?? (opts.destroy ? "stopped" : "paused");
  const patch: ThreadPatch = {
    status,
    runningSince: null,
    idleSince: null,
    runnerUrl: null,
    background: null,
    drainRequestedAt: null,
    drainedAt: null,
    ...(opts.destroy ? { sandboxId: null } : {}),
  };
  const [claimed] = await ctx.db
    .update(threads)
    .set(patch)
    .where(and(eq(threads.id, row.id), isNotNull(threads.runningSince)))
    .returning();

  if (!claimed) {
    // Not running (already paused, or another request got here first). Destroy still marks it stopped.
    return opts.destroy ? updateRow(ctx, row.id, patch) : ((await getRow(ctx, row.id)) ?? row);
  }

  if (row.runningSince && row.sandboxId) {
    const endedAtMs = Date.now();
    const run = {
      ...runningSandbox(row),
      endedAt: new Date(endedAtMs).toISOString(),
      runtimeSeconds: runtimeSeconds(iso(row.runningSince), endedAtMs),
      endReason,
    };
    try {
      await ctx.db.insert(sandboxRuns).values({
        threadId: row.id,
        workspaceId: row.workspaceId,
        sandboxId: row.sandboxId,
        size: row.sandboxSize,
        startedAt: run.runningSince,
        endedAt: run.endedAt,
        runtimeSeconds: run.runtimeSeconds,
        endReason,
      });
    } catch (err) {
      console.error("[lemonlime] could not record sandbox run:", err);
    }
    await notify("onSandboxStopped", () => ctx.plugin.usagePolicy.onSandboxStopped(run));
  }
  return claimed;
}

export async function pauseThread(ctx: AppContext, userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads run on your computer and cannot be paused here.");
  if (!row.runningSince) return threadResponse(ctx, row, userId);
  return threadResponse(ctx, await endRun(ctx, row, "user"), userId);
}

export async function resumeThread(ctx: AppContext, userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads run on your computer and cannot be resumed here.");
  if (row.runningSince) return threadResponse(ctx, row, userId); // already running
  if (!row.sandboxId || row.status === "stopped") throw new HttpError(409, "This thread's sandbox no longer exists.");

  const { usagePolicy } = ctx.plugin;
  const decision = await usagePolicy.canStartSandbox({
    userId,
    workspaceId: row.workspaceId,
    threadId: row.id,
    size: row.sandboxSize,
  });
  if (!decision.allow) throw new PolicyDeniedError(decision);

  let info;
  try {
    info = await ctx.sandbox().resume(row.sandboxId, await launchFor(ctx, row));
  } catch (err) {
    throw new HttpError(502, `Could not resume the sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = new Date().toISOString();
  const updated = await updateRow(ctx, row.id, {
    status: "provisioning",
    sandboxId: info.id,
    runnerUrl: info.runnerUrl,
    runningSince: now,
    idleSince: now,
    lastHeartbeatAt: null,
    background: null,
    drainRequestedAt: null,
    drainedAt: null,
  });
  await notify("onSandboxStarted", () => usagePolicy.onSandboxStarted(runningSandbox(updated)));
  return threadResponse(ctx, updated, userId);
}

export async function deleteThread(ctx: AppContext, userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  if (row.mode !== "cloud") {
    return threadResponse(ctx, await updateRow(ctx, row.id, { status: "stopped" }), userId);
  }
  return threadResponse(ctx, await endRun(ctx, row, "user", { destroy: true }), userId);
}

// ─── Runner heartbeats ──────────────────────────────────────────────────────

/** Record a heartbeat. The caller has verified the runner token for `hb.threadId`. */
export async function recordHeartbeat(ctx: AppContext, hb: RunnerHeartbeat): Promise<HeartbeatResponse> {
  const row = await getRow(ctx, hb.threadId);
  if (!row) throw new HttpError(404, "Thread not found.");
  const latestSeq = Math.max(row.latestSeq, hb.latestSeq);
  const now = new Date().toISOString();

  // The control plane already paused or stopped this sandbox: keep our state and ask the runner to stop.
  if (row.mode === "cloud" && !row.runningSince) {
    await updateRow(ctx, row.id, { latestSeq, lastHeartbeatAt: now });
    return { action: "shutdown", pendingMessages: 0 };
  }

  // The agent started working again (e.g. a message arrived): call off any pending drain.
  const working = hb.status === "running";
  const drainRequestedAt = working ? null : row.drainRequestedAt;
  const drainedAt = working ? null : hb.drained && drainRequestedAt ? now : row.drainedAt;
  await updateRow(ctx, row.id, {
    status: hb.status,
    latestSeq,
    idleSince: hb.idleSince,
    lastHeartbeatAt: now,
    background: hb.background ?? null,
    drainRequestedAt,
    drainedAt,
  });
  const pending = await countPendingMessages(ctx, row.id);
  return { action: drainRequestedAt && !drainedAt ? "drain" : "none", pendingMessages: pending };
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

export interface SweepResult {
  checked: number;
  paused: Array<{ threadId: string; endReason: EndReason }>;
  /** Asked to drain this time; paused by a later sweep. */
  draining: string[];
  errors: Array<{ threadId: string; error: string }>;
}

/** Pause idle, silent and no-longer-allowed cloud sandboxes. Safe to call as often as you like. */
export async function sweepRunningSandboxes(ctx: AppContext, nowMs: number = Date.now()): Promise<SweepResult> {
  const rows = await ctx.db
    .select()
    .from(threads)
    .where(and(eq(threads.mode, "cloud"), isNotNull(threads.runningSince), isNotNull(threads.sandboxId)));
  const running = rows.map(toSweepThread);

  const { usagePolicy } = ctx.plugin;
  const decision = await decideSweep(running, nowMs, t => usagePolicy.canKeepRunning(runningSandbox(t.row)));

  const result: SweepResult = {
    checked: running.length,
    paused: [],
    draining: [],
    errors: decision.errors.map(e => ({ threadId: e.thread.id, error: e.error })),
  };
  const nowIso = new Date(nowMs).toISOString();
  for (const { thread } of decision.drain) {
    // The runner is told to drain in its next heartbeat; the next sweep pauses it.
    await ctx.db
      .update(threads)
      .set({ drainRequestedAt: nowIso, drainedAt: null })
      .where(and(eq(threads.id, thread.id), isNull(threads.drainRequestedAt)));
    result.draining.push(thread.id);
  }
  for (const { thread, endReason } of decision.pause) {
    try {
      await endRun(ctx, thread.row, endReason, thread.row.status === "failed" ? { status: "failed" } : {});
      result.paused.push({ threadId: thread.id, endReason });
    } catch (err) {
      result.errors.push({ threadId: thread.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
