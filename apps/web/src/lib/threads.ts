import { and, asc, eq, isNotNull, isNull, like, lt, ne } from "drizzle-orm";
import { z } from "zod";
import {
  RUNNER_STATUSES,
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
import { canTakePartIn, getThreadForUser, getThreadToTakePart, listThreadsForUser, requireTakingPart, sharedWithWorkspace, startedBy } from "./access.ts";
import type { AppContext } from "./context.ts";
import { HttpError, PolicyDeniedError } from "./errors.ts";
import { addPendingMessageIfRoom, countPendingMessages } from "./history.ts";
import { credentialsForSandbox } from "./agent-credentials.ts";
import { secretsForSandbox } from "./secrets.ts";
import { RUNNER_PORT, buildRunnerLaunch, validateCloudLaunch } from "./runner-command.ts";
import { decideSweep, runtimeSeconds, type EndReason, type SweepThread } from "./sweep.ts";
import { issueClientToken, threadSecret } from "./tokens.ts";
import { githubAppConfig, tokenForThread } from "./github.ts";
import { memberRole } from "./members.ts";
import { enforce, LIMITS } from "./rate-limit.ts";
import { relayEnabled } from "./relay.ts";
import { sandboxSettings } from "./workspace-settings.ts";

export type { ThreadRow };

/** Response for one thread: the protocol shape plus the first prompt, if the thread has one. */
export type ThreadResponse = ThreadWithEndpoint & { initialPrompt: string | null; pullRequestUrl: string | null };

const iso = (value: string): string => new Date(value).toISOString();
const isoOrNull = (value: string | null): string | null => (value ? iso(value) : null);

/** The thread as one person sees it: whether it is theirs, and whether its starter has shared it. */
export function rowToThread(row: ThreadRow, viewerId: string): Thread {
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
    mine: startedBy(row, viewerId),
    shared: sharedWithWorkspace(row),
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
  if (!row || row.mode !== "cloud" || !LIVE_STATUSES.has(row.status) || isWaking(row)) throw new HttpError(404, "Thread not found.");
  return row;
}

async function getRow(ctx: AppContext, id: string): Promise<ThreadRow | null> {
  return (await ctx.db.select().from(threads).where(eq(threads.id, id)).get()) ?? null;
}

/** The thread, if the user is a member of its workspace; otherwise 404. */
export function getThreadRowForUser(ctx: AppContext, userId: string, id: string): Promise<ThreadRow> {
  return getThreadForUser(ctx.db, userId, id);
}

/** The thread, for a member who may take part in it (403 for one who may only read it). */
export function getThreadRowToTakePart(ctx: AppContext, userId: string, id: string): Promise<ThreadRow> {
  return getThreadToTakePart(ctx.db, userId, id);
}

/** Threads in a workspace the user belongs to (403 otherwise). */
export async function listThreads(ctx: AppContext, userId: string, workspaceId: string, limit = 200): Promise<Thread[]> {
  return (await listThreadsForUser(ctx.db, userId, workspaceId, limit)).map(row => rowToThread(row, userId));
}

const LIVE_STATUSES = new Set<Thread["status"]>(["provisioning", "idle", "running"]);

/**
 * A resume marks the thread "provisioning" before it wakes the sandbox, so a second resume
 * at the same moment can tell one is under way. Until it finishes the sandbox isn't running.
 */
const isWaking = (row: ThreadRow): boolean => row.status === "provisioning" && !row.runningSince && Boolean(row.sandboxId);

/** How long one resume may take. After this another request may try again (the first one probably died). */
const RESUME_TAKES_AT_MOST_MS = 2 * 60 * 1000;

/**
 * A fresh WebSocket endpoint and client token, when the thread's cloud runner is reachable.
 * The token opens the agent, the sandbox's terminal and its files, so it is only made for
 * someone who may take part in the thread. Everyone else gets none and reads stored history.
 */
export async function endpointFor(ctx: AppContext, row: ThreadRow, userId: string): Promise<RunnerEndpoint | null> {
  if (!canTakePartIn(row, userId)) return null;
  if (row.mode !== "cloud" || !row.runnerUrl || !row.runningSince || !LIVE_STATUSES.has(row.status)) return null;
  const { token, expiresAt } = await issueClientToken({ masterSecret: ctx.config.tokenSecret(), threadId: row.id, userId });
  return { url: runnerWsUrl(row.runnerUrl), token, expiresAt };
}

export async function threadResponse(ctx: AppContext, row: ThreadRow, userId: string): Promise<ThreadResponse> {
  return {
    thread: rowToThread(row, userId),
    endpoint: await endpointFor(ctx, row, userId),
    initialPrompt: row.initialPrompt,
    pullRequestUrl: row.pullRequestUrl,
  };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * How to start a thread's runner. Secrets are only added for a new sandbox: providers keep
 * a sandbox's environment across pauses, and changing a secret applies to new threads.
 * `secretNames` narrows the workspace secrets to the ones named (an automation's choice).
 */
async function launchFor(
  ctx: AppContext,
  row: Pick<ThreadRow, "id" | "agent" | "repo" | "workspaceId" | "createdBy">,
  opts: { withSecrets?: boolean; secretNames?: readonly string[] | null } = {},
) {
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
          secrets: {
            ...(await secretsForSandbox(ctx, row.workspaceId, opts.secretNames)),
            ...(await credentialsForSandbox(ctx, row.createdBy, row.agent.kind)).env,
          },
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
 * agrees); local ones are metadata only. The sandbox gets every workspace secret, or
 * only the ones in `opts.secretNames` when that is a list.
 */
export async function createThread(
  ctx: AppContext,
  userId: string,
  workspaceId: string,
  req: CreateThreadRequest,
  opts: { secretNames?: readonly string[] | null } = {},
): Promise<ThreadResponse> {
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

  // The thread now exists. Whatever goes wrong from here, it must not be left "provisioning",
  // and a sandbox that was made must not be left running with nothing keeping track of it.
  let info;
  try {
    info = await provider.create({
      threadId: id,
      size: req.sandboxSize,
      runner: await launchFor(ctx, inserted!, { withSecrets: true, secretNames: opts.secretNames }),
      labels: { "lemonlime.workspace": workspaceId, "lemonlime.runner-port": String(RUNNER_PORT) },
    });
  } catch (err) {
    await markFailed(ctx, id);
    if (err instanceof HttpError) throw err;
    // The provider's own words stay in the log: they can name hosts, images or accounts.
    console.error(`[lemonlime] could not start the sandbox for thread ${id}:`, err);
    throw new HttpError(502, COULD_NOT_START);
  }

  let row: ThreadRow;
  try {
    const now = new Date().toISOString();
    row = await updateRow(ctx, id, {
      sandboxId: info.id,
      runnerUrl: info.runnerUrl,
      runningSince: now,
      idleSince: now,
      lastHeartbeatAt: null,
    });
  } catch (err) {
    console.error(`[lemonlime] could not record the sandbox for thread ${id}; removing it:`, err);
    await provider.destroy(info.id).catch(e => console.error(`[lemonlime] could not remove sandbox ${info.id}:`, e));
    await markFailed(ctx, id);
    throw new HttpError(502, COULD_NOT_START);
  }
  await notify("onSandboxStarted", () => usagePolicy.onSandboxStarted(runningSandbox(row)));
  await threadCreated(ctx, row, userId);
  return threadResponse(ctx, row, userId);
}

const COULD_NOT_START = "Could not start the sandbox. Try again in a moment.";
const COULD_NOT_RESUME = "Could not resume the sandbox. Try again in a moment.";

/** Mark a thread whose sandbox never started. Never throws: the caller is already reporting an error. */
async function markFailed(ctx: AppContext, id: string): Promise<void> {
  await ctx.db
    .update(threads)
    .set({ status: "failed" })
    .where(eq(threads.id, id))
    .catch(err => console.error(`[lemonlime] could not mark thread ${id} as failed:`, err));
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

// ─── Sandboxes the provider would not stop ──────────────────────────────────

/** `system_status` rows that each name one sandbox the provider still has to pause or remove. */
const LEFTOVER_PREFIX = "sandbox.leftover:";
type Leftover = { threadId: string; action: "pause" | "destroy" };

/** Most leftover sandboxes one sweep asks the provider about again. */
const LEFTOVER_BATCH = 25;

/** Note a sandbox the provider failed to pause or remove, for the sweep to ask again. */
async function rememberLeftover(ctx: AppContext, sandboxId: string, leftover: Leftover): Promise<void> {
  const value = JSON.stringify(leftover);
  const now = new Date().toISOString();
  await ctx.db
    .insert(systemStatus)
    .values({ key: `${LEFTOVER_PREFIX}${sandboxId}`, value, updatedAt: now })
    .onConflictDoUpdate({ target: systemStatus.key, set: { value, updatedAt: now } });
}

async function forgetLeftover(ctx: AppContext, sandboxId: string): Promise<void> {
  await ctx.db.delete(systemStatus).where(eq(systemStatus.key, `${LEFTOVER_PREFIX}${sandboxId}`));
}

export interface LeftoverSweep {
  /** Sandboxes the provider has stopped at last. */
  stopped: string[];
  /** Still not stopped; asked again by the next sweep. */
  errors: Array<{ sandboxId: string; error: string }>;
}

/**
 * Ask the provider again about sandboxes it failed to pause or remove when their thread
 * was paused or closed. A sandbox to pause is left alone if its thread has been woken or
 * closed since (closing asks for the removal itself).
 */
export async function retryLeftoverSandboxes(ctx: AppContext): Promise<LeftoverSweep> {
  const out: LeftoverSweep = { stopped: [], errors: [] };
  // Longest-waiting first; one that fails goes to the back, so a stuck few never starve the rest.
  const rows = await ctx.db
    .select()
    .from(systemStatus)
    .where(like(systemStatus.key, `${LEFTOVER_PREFIX}%`))
    .orderBy(asc(systemStatus.updatedAt))
    .limit(LEFTOVER_BATCH);
  for (const { key, value } of rows) {
    const sandboxId = key.slice(LEFTOVER_PREFIX.length);
    try {
      const leftover = JSON.parse(value) as Leftover;
      if (leftover.action === "destroy") {
        await ctx.sandbox().destroy(sandboxId);
        out.stopped.push(sandboxId);
      } else {
        const thread = await getRow(ctx, leftover.threadId);
        if (thread && thread.sandboxId === sandboxId && !thread.runningSince && !isWaking(thread)) {
          await ctx.sandbox().pause(sandboxId);
          out.stopped.push(sandboxId);
        }
      }
      await forgetLeftover(ctx, sandboxId);
    } catch (err) {
      // The provider's own words stay in the log: they can name hosts or accounts.
      console.error(`[lemonlime] sandbox ${sandboxId} still could not be stopped:`, err);
      out.errors.push({ sandboxId, error: "The sandbox provider could not stop it." });
      await ctx.db
        .update(systemStatus)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(systemStatus.key, key))
        .catch(() => {});
    }
  }
  return out;
}

/**
 * End the thread's current run: pause or destroy the sandbox, then record the run
 * exactly once (the conditional update on `running_since` makes this idempotent).
 *
 * A provider that fails doesn't stop the thread being paused or closed here: the sandbox
 * is noted first, and the sweep keeps asking the provider until it is stopped
 * (`retryLeftoverSandboxes`). Only if that note can't be written does this throw, with the
 * thread left as it was, so the sandbox is never both running and forgotten.
 */
export async function endRun(
  ctx: AppContext,
  row: ThreadRow,
  endReason: EndReason,
  opts: { destroy?: boolean; status?: Thread["status"] } = {},
): Promise<ThreadRow> {
  if (row.sandboxId) {
    const action = opts.destroy ? "destroy" : "pause";
    try {
      const provider = ctx.sandbox();
      if (opts.destroy) await provider.destroy(row.sandboxId);
      else await provider.pause(row.sandboxId);
      // A removed sandbox needs no more asking, whatever was noted about it before.
      if (opts.destroy) await forgetLeftover(ctx, row.sandboxId).catch(() => {});
    } catch (err) {
      console.error(`[lemonlime] could not ${action} sandbox ${row.sandboxId} of thread ${row.id}; the sweep will try again:`, err);
      await rememberLeftover(ctx, row.sandboxId, { threadId: row.id, action });
    }
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

/** Pause a cloud thread's sandbox. Anyone who may take part in the thread can, and so can a workspace owner. */
export async function pauseThread(ctx: AppContext, userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  if ((await memberRole(ctx.db, userId, row.workspaceId)) !== "owner") await requireTakingPart(ctx.db, row, userId);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads run on your computer and cannot be paused here.");
  if (!row.runningSince) return threadResponse(ctx, row, userId);
  return threadResponse(ctx, await endRun(ctx, row, "user"), userId);
}

/**
 * Save a message for a cloud thread whose agent the sender isn't connected to, and wake
 * its sandbox if it is paused; the runner picks the message up from here. Sending the same
 * `clientMsgId` again is harmless. The limits are counted before anything is saved or
 * started. If the usage policy won't start the sandbox, the message stays saved and the
 * error says why.
 */
export async function queueMessage(ctx: AppContext, userId: string, id: string, msg: { clientMsgId: string; text: string }): Promise<ThreadResponse> {
  const row = await getThreadRowToTakePart(ctx, userId, id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads take messages through the desktop app.");
  if (row.status === "stopped" || !row.sandboxId) throw new HttpError(409, "This thread's sandbox no longer exists.");
  await enforce(ctx.db, `messages:${userId}`, LIMITS.messagesPerUser, "messages");
  if (!row.runningSince) await enforce(ctx.db, `sandbox-starts:${userId}`, LIMITS.sandboxStartsPerUser, "sandbox starts");
  // People's messages never carry a check script; only automations set one.
  if (!(await addPendingMessageIfRoom(ctx, row.id, { clientMsgId: msg.clientMsgId, text: msg.text }))) {
    throw new HttpError(429, "Too many messages are waiting for this thread. Let the agent catch up, then send it again.");
  }
  if (row.runningSince) return threadResponse(ctx, row, userId);
  return resumeThread(ctx, userId, row.id);
}

/**
 * Wake a paused thread's sandbox. Only one request at a time does the waking: the others
 * get the thread as it is ("provisioning", no endpoint yet) and can ask again shortly.
 */
export async function resumeThread(ctx: AppContext, userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowToTakePart(ctx, userId, id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads run on your computer and cannot be resumed here.");
  if (row.runningSince) return threadResponse(ctx, row, userId); // already running
  if (!row.sandboxId || row.status === "stopped") throw new HttpError(409, "This thread's sandbox no longer exists.");
  const sandboxId = row.sandboxId;
  // Another request is waking it right now.
  const takingOver = isWaking(row);
  if (takingOver && Date.now() - Date.parse(row.updatedAt) < RESUME_TAKES_AT_MOST_MS) return threadResponse(ctx, row, userId);

  const { usagePolicy } = ctx.plugin;
  const decision = await usagePolicy.canStartSandbox({
    userId,
    workspaceId: row.workspaceId,
    threadId: row.id,
    size: row.sandboxSize,
  });
  if (!decision.allow) throw new PolicyDeniedError(decision);

  // Claim the resume: the update only applies if the thread is still as it was read, so of
  // two requests at the same moment exactly one goes on to wake the sandbox.
  const [claimed] = await ctx.db
    .update(threads)
    .set({ status: "provisioning" })
    .where(
      and(
        eq(threads.id, row.id),
        eq(threads.status, row.status),
        isNull(threads.runningSince),
        // Taking over a resume that died changes nothing but the time, so that is what tells two takers apart.
        ...(takingOver ? [eq(threads.updatedAt, row.updatedAt)] : []),
      ),
    )
    .returning();
  if (!claimed) return threadResponse(ctx, await currentRow(ctx, row.id), userId);

  // Give the claim back, so the thread can be resumed again after a failure.
  const before = takingOver ? "paused" : row.status;
  const release = () =>
    ctx.db
      .update(threads)
      .set({ status: before })
      .where(and(eq(threads.id, row.id), eq(threads.status, "provisioning"), isNull(threads.runningSince)))
      .catch(err => console.error(`[lemonlime] could not put thread ${row.id} back after a failed resume:`, err));

  let info;
  try {
    info = await ctx.sandbox().resume(sandboxId, await launchFor(ctx, row));
  } catch (err) {
    await release();
    if (err instanceof HttpError) throw err;
    console.error(`[lemonlime] could not resume the sandbox for thread ${row.id}:`, err);
    throw new HttpError(502, COULD_NOT_RESUME);
  }

  let updated: ThreadRow | undefined;
  try {
    const now = new Date().toISOString();
    [updated] = await ctx.db
      .update(threads)
      .set({
        status: "provisioning",
        sandboxId: info.id,
        runnerUrl: info.runnerUrl,
        runningSince: now,
        idleSince: now,
        lastHeartbeatAt: null,
        background: null,
        drainRequestedAt: null,
        drainedAt: null,
      })
      .where(and(eq(threads.id, row.id), eq(threads.status, "provisioning"), isNull(threads.runningSince)))
      .returning();
  } catch (err) {
    console.error(`[lemonlime] could not record the resumed sandbox for thread ${row.id}; pausing it again:`, err);
    await ctx
      .sandbox()
      .pause(info.id)
      .catch(e => console.error(`[lemonlime] could not pause sandbox ${info.id}:`, e));
    await release();
    throw new HttpError(502, COULD_NOT_RESUME);
  }
  // The thread changed while its sandbox woke (it was closed, say): report it as it is now.
  if (!updated) return threadResponse(ctx, await currentRow(ctx, row.id), userId);
  const started = updated;
  await notify("onSandboxStarted", () => usagePolicy.onSandboxStarted(runningSandbox(started)));
  return threadResponse(ctx, started, userId);
}

async function currentRow(ctx: AppContext, id: string): Promise<ThreadRow> {
  const row = await getRow(ctx, id);
  if (!row) throw new HttpError(404, "Thread not found.");
  return row;
}

export const ONLY_THE_STARTER_SHARES = "Only the person who started this thread can share it with the workspace.";

/** What `PATCH /api/threads/:id` takes: a new title, whether the workspace may take part, or both. */
export const ThreadChange = z
  .object({ title: z.string().min(1).max(200).optional(), shared: z.boolean().optional() })
  .refine(change => change.title !== undefined || change.shared !== undefined, "Send a title, shared, or both.");
export type ThreadChange = z.infer<typeof ThreadChange>;

/**
 * Change a thread's title, or whether the rest of its workspace may take part in it.
 * Renaming is for anyone who may take part. Sharing hands other members the agent, the
 * sandbox and the starter's agent sign-in, so only the starter can switch it on or off.
 */
export async function updateThread(ctx: AppContext, userId: string, id: string, change: ThreadChange): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  const patch: ThreadPatch = {};
  if (change.shared !== undefined) {
    if (!startedBy(row, userId)) throw new HttpError(403, ONLY_THE_STARTER_SHARES);
    patch.shared = change.shared;
  }
  if (change.title !== undefined) {
    await requireTakingPart(ctx.db, row, userId);
    const clean = change.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!clean) throw new HttpError(400, "Give the thread a name.");
    patch.title = clean;
  }
  if (!Object.keys(patch).length) return threadResponse(ctx, row, userId);
  return threadResponse(ctx, await updateRow(ctx, row.id, patch), userId);
}

/** Give the thread a new title (anyone who may take part in it). */
export function renameThread(ctx: AppContext, userId: string, id: string, title: string): Promise<ThreadResponse> {
  return updateThread(ctx, userId, id, { title });
}

/** Close a thread and remove its sandbox. The person who started it or a workspace owner may. */
export async function deleteThread(ctx: AppContext, userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(ctx, userId, id);
  if (row.createdBy !== userId && (await memberRole(ctx.db, userId, row.workspaceId)) !== "owner") {
    throw new HttpError(403, "Only the person who started this thread or a workspace owner can close it.");
  }
  if (row.mode !== "cloud") {
    return threadResponse(ctx, await updateRow(ctx, row.id, { status: "stopped" }), userId);
  }
  return threadResponse(ctx, await endRun(ctx, row, "user", { destroy: true }), userId);
}

/**
 * The person who started a cloud thread is about to sign its agent in. The sign-in its
 * sandbox then saves (so their next sandboxes start signed in) is only accepted for a while
 * after this. The login is saved to that person's account, so nobody else may ask: not
 * another member of the workspace, and not an owner.
 */
export async function requestAgentSignIn(ctx: AppContext, userId: string, id: string): Promise<void> {
  const row = await getThreadRowForUser(ctx, userId, id);
  if (row.mode !== "cloud") throw new HttpError(400, "Only cloud threads sign in inside a sandbox.");
  if (row.createdBy !== userId) throw new HttpError(403, "Only the person who started this thread can sign its agent in.");
  await ctx.db.update(threads).set({ signInRequestedAt: new Date().toISOString() }).where(eq(threads.id, row.id));
}

// ─── Runner heartbeats ──────────────────────────────────────────────────────

/** Record a heartbeat. The caller has verified the runner token for `hb.threadId`. */
export async function recordHeartbeat(ctx: AppContext, hb: RunnerHeartbeat): Promise<HeartbeatResponse> {
  const row = await getRow(ctx, hb.threadId);
  // Only cloud threads have a runner that reports here.
  if (!row || row.mode !== "cloud") throw new HttpError(404, "Thread not found.");
  // A runner only ever says it is starting, idle or working. Pausing, closing and failing are decided here.
  if (!(RUNNER_STATUSES as readonly string[]).includes(hb.status)) throw new HttpError(400, "A runner can't report that status.");
  const latestSeq = Math.max(row.latestSeq, hb.latestSeq);
  const now = new Date().toISOString();

  // The control plane already paused or stopped this sandbox: keep our state and ask the runner to stop.
  if (!row.runningSince) {
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
