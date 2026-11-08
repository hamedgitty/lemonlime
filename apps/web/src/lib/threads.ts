import { and, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";
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
import { sandboxRuns, systemStatus, threads, workspaceSettings, type ThreadRow } from "@lemonlime/db";
import { getThreadForUser, listThreadsForUser } from "./access.ts";
import type { AppContext } from "./context.ts";
import { HttpError, PolicyDeniedError } from "./errors.ts";
import { countPendingMessages } from "./history.ts";
import { credentialsForSandbox } from "./agent-credentials.ts";
import { secretsForSandbox } from "./secrets.ts";
import { RUNNER_PORT, buildRunnerLaunch, validateCloudLaunch } from "./runner-command.ts";
import { decideSweep, runtimeSeconds, type EndReason, type SweepThread } from "./sweep.ts";
import { issueClientToken, threadSecret } from "./tokens.ts";
import { githubAppConfig, tokenForThread } from "./github.ts";
import { relayEnabled } from "./relay.ts";
import { sandboxSettings } from "./workspace-settings.ts";

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
    activity: {
      agentWorking: row.status === "running",
      cpuCores: row.cpuCores ?? null,
      topProcess: row.topProcess ?? null,
      reportedAt: row.lastHeartbeatAt ?? null,
    },
  };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** A thread row by id, without an access check (for runner-authenticated routes). */
export function getThreadRow(ctx: AppContext, id: string): Promise<ThreadRow | null> {
  return getRow(ctx, id);
}

/**
 * For runner routes that hand something out or change the thread: the cloud thread, only
 * while its sandbox is meant to be running. Whoever once got hold of a thread's secret
 * can't keep using it after the thread is paused or closed.
 */
export async function getLiveRunnerThread(ctx: AppContext, id: string): Promise<ThreadRow> {
  const row = await getRow(ctx, id);
  if (!row || row.mode !== "cloud" || !LIVE_STATUSES.has(row.status)) throw new HttpError(404, "Thread not found.");
  return row;
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
async function launchFor(ctx: AppContext, row: Pick<ThreadRow, "id" | "agent" | "repo" | "workspaceId" | "createdBy">, opts: { withSecrets?: boolean } = {}) {
  const relay = relayEnabled(ctx.vars);
  const launch = buildRunnerLaunch({
    relay,
    ...(relay ? { gitToken: await firstGitToken(ctx, row) } : {}),
    threadId: row.id,
    agent: row.agent,
    repo: row.repo,
    controlPlaneUrl: ctx.config.runnerControlPlaneUrl(),
    threadSecret: await threadSecret(ctx.config.tokenSecret(), row.id),
    ...(opts.withSecrets
      ? {
          // Workspace secrets, plus the creator's saved sign-in for this agent (if any).
          secrets: { ...(await secretsForSandbox(ctx, row.workspaceId)), ...(await credentialsForSandbox(ctx, row.createdBy, row.agent.kind)).env },
        }
      : {}),
  });
  if (opts.withSecrets) {
    const { files } = await credentialsForSandbox(ctx, row.createdBy, row.agent.kind);
    if (Object.keys(files).length) launch.env.LEMONLIME_AGENT_FILES = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(files))));
    // The workspace's cloud settings, like secrets, are fixed when the sandbox is made.
    const settings = await sandboxSettings(ctx, row.workspaceId);
    Object.assign(launch.env, settings.env);
    if (settings.retryMaxWaitMinutes > 0) launch.env.LEMONLIME_RETRY_MAX_WAIT = String(settings.retryMaxWaitMinutes);
    if (settings.setupScript) launch.setupScript = settings.setupScript;
  }
  return launch;
}

/** Relay mode: a repository token for the runner to start with (none if the repo isn't covered). */
async function firstGitToken(ctx: AppContext, row: Pick<ThreadRow, "workspaceId" | "repo">) {
  const cfg = githubAppConfig(ctx.vars);
  if (!cfg) return undefined;
  const creds = await tokenForThread(ctx, row).catch(err => (console.error("[lemonlime] first git token failed:", err), null));
  return creds ? { token: creds.token, expiresAt: creds.expiresAt, host: new URL(cfg.webUrl).host } : undefined;
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
    await threadCreated(ctx, row!, userId);
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
  await threadCreated(ctx, row, userId);
  return threadResponse(ctx, row, userId);
}

/** Tell the deployment's plugin; it must never stop a thread being created. */
async function threadCreated(ctx: AppContext, row: ThreadRow, userId: string): Promise<void> {
  await ctx.plugin.events
    .onThreadCreated?.({ threadId: row.id, workspaceId: row.workspaceId, userId, mode: row.mode, agent: row.agent.kind })
    .catch(err => console.error("[lemonlime] onThreadCreated failed:", err));
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

/** Give the thread a new title (members of its workspace only). */
export async function renameThread(ctx: AppContext, userId: string, id: string, title: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean) throw new HttpError(400, "Give the thread a name.");
  return threadResponse(ctx, await updateRow(ctx, row.id, { title: clean }), userId);
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
    cpuCores: hb.load?.cpuCores ?? null,
    topProcess: hb.load?.topProcess ?? null,
    drainRequestedAt,
    drainedAt,
  });
  const pending = await countPendingMessages(ctx, row.id);
  return { action: drainRequestedAt && !drainedAt ? "drain" : "none", pendingMessages: pending };
}

// ─── Auto-delete ────────────────────────────────────────────────────────────

/** Most threads closed by one sweep; the rest wait for the next minute. */
const AUTO_DELETE_BATCH = 25;

/**
 * Close cloud threads that have had no activity for the number of days their workspace
 * chose (workspace_settings.auto_delete_days) and delete their sandboxes. Their history
 * stays readable. Workspaces without the setting are left alone.
 */
export async function closeInactiveThreads(
  ctx: AppContext,
  nowMs: number = Date.now(),
): Promise<{ closed: string[]; errors: Array<{ threadId: string; error: string }> }> {
  const out = { closed: [] as string[], errors: [] as Array<{ threadId: string; error: string }> };
  const workspaces = await ctx.db
    .select({ workspaceId: workspaceSettings.workspaceId, days: workspaceSettings.autoDeleteDays })
    .from(workspaceSettings)
    .where(isNotNull(workspaceSettings.autoDeleteDays));
  for (const { workspaceId, days } of workspaces) {
    if (!days || days < 1 || out.closed.length >= AUTO_DELETE_BATCH) continue;
    const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
    // Every heartbeat updates a thread, so a sandbox that is still working is never this old.
    const stale = await ctx.db
      .select()
      .from(threads)
      .where(and(eq(threads.workspaceId, workspaceId), eq(threads.mode, "cloud"), ne(threads.status, "stopped"), lt(threads.updatedAt, cutoff)))
      .limit(AUTO_DELETE_BATCH - out.closed.length);
    for (const row of stale) {
      try {
        await endRun(ctx, row, "idle", { destroy: true });
        out.closed.push(row.id);
      } catch (err) {
        out.errors.push({ threadId: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
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
  // For /api/health: a sweep that stops running means idle sandboxes stop pausing.
  await ctx.db
    .insert(systemStatus)
    .values({ key: "sweep.last_run", value: nowIso, updatedAt: nowIso })
    .onConflictDoUpdate({ target: systemStatus.key, set: { value: nowIso, updatedAt: nowIso } })
    .catch(err => console.error("[lemonlime] could not record the sweep time:", err));
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
