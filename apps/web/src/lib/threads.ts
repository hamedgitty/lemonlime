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
import { userWorkspaceIds } from "./auth.ts";
import { env } from "./env.ts";
import { HttpError, PolicyDeniedError } from "./http.ts";
import { getPlugin } from "./plugin.ts";
import { RUNNER_PORT, buildRunnerLaunch, validateCloudLaunch } from "./runner-command.ts";
import { getSandboxProvider } from "./sandbox.ts";
import { supabaseAdmin } from "./supabase/admin.ts";
import { decideSweep, runtimeSeconds, type EndReason, type SweepThread } from "./sweep.ts";
import { issueClientToken, threadSecret } from "./tokens.ts";

/** A row of `public.threads`. */
export interface ThreadRow {
  id: string;
  workspace_id: string;
  created_by: string | null;
  title: string;
  agent: Thread["agent"];
  repo: Thread["repo"];
  branch: string;
  mode: Thread["mode"];
  status: Thread["status"];
  sandbox_size: Thread["sandboxSize"];
  sandbox_provider: string | null;
  sandbox_id: string | null;
  runner_url: string | null;
  latest_seq: number;
  idle_since: string | null;
  running_since: string | null;
  last_heartbeat_at: string | null;
  initial_prompt: string | null;
  created_at: string;
  updated_at: string;
}

/** Response for one thread: the protocol shape plus the first prompt, if the thread has one. */
export type ThreadResponse = ThreadWithEndpoint & { initialPrompt: string | null };

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
    sandboxSize: row.sandbox_size,
    latestSeq: row.latest_seq,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function toSweepThread(row: ThreadRow): SweepThread & { row: ThreadRow } {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    sandboxId: row.sandbox_id,
    idleSince: isoOrNull(row.idle_since),
    runningSince: isoOrNull(row.running_since),
    lastHeartbeatAt: isoOrNull(row.last_heartbeat_at),
    row,
  };
}

function runningSandbox(row: ThreadRow): RunningSandbox {
  return {
    userId: row.created_by ?? "",
    workspaceId: row.workspace_id,
    threadId: row.id,
    size: row.sandbox_size,
    sandboxId: row.sandbox_id ?? "",
    runningSince: iso(row.running_since ?? row.updated_at),
  };
}

// ─── Reading ────────────────────────────────────────────────────────────────

async function getRow(id: string): Promise<ThreadRow | null> {
  const { data, error } = await supabaseAdmin().from("threads").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as ThreadRow | null) ?? null;
}

/** The thread, if the user is a member of its workspace; otherwise 404. */
export async function getThreadRowForUser(userId: string, id: string): Promise<ThreadRow> {
  const row = await getRow(id);
  if (!row) throw new HttpError(404, "Thread not found.");
  const workspaces = await userWorkspaceIds(userId);
  if (!workspaces.includes(row.workspace_id)) throw new HttpError(404, "Thread not found.");
  return row;
}

export async function listThreads(workspaceId: string, limit = 200): Promise<Thread[]> {
  const { data, error } = await supabaseAdmin()
    .from("threads")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ThreadRow[]).map(rowToThread);
}

const LIVE_STATUSES = new Set<Thread["status"]>(["provisioning", "idle", "running"]);

/** A fresh WebSocket endpoint and client token, when the thread's cloud runner is reachable. */
export async function endpointFor(row: ThreadRow, userId: string): Promise<RunnerEndpoint | null> {
  if (row.mode !== "cloud" || !row.runner_url || !row.running_since || !LIVE_STATUSES.has(row.status)) return null;
  const { token, expiresAt } = await issueClientToken({ masterSecret: env.tokenSecret(), threadId: row.id, userId });
  return { url: runnerWsUrl(row.runner_url), token, expiresAt };
}

export async function threadResponse(row: ThreadRow, userId: string): Promise<ThreadResponse> {
  return { thread: rowToThread(row), endpoint: await endpointFor(row, userId), initialPrompt: row.initial_prompt };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

async function launchFor(row: Pick<ThreadRow, "id" | "agent" | "repo">) {
  return buildRunnerLaunch({
    threadId: row.id,
    agent: row.agent,
    repo: row.repo,
    controlPlaneUrl: env.publicUrl(),
    threadSecret: await threadSecret(env.tokenSecret(), row.id),
  });
}

async function updateRow(id: string, patch: Partial<ThreadRow>): Promise<ThreadRow> {
  const { data, error } = await supabaseAdmin().from("threads").update(patch).eq("id", id).select("*").single();
  if (error) throw error;
  return data as ThreadRow;
}

/** Tell the plugin about a start/stop without letting a failing hook break the request. */
async function notify(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[lemonlime] usage policy ${what} hook failed:`, err);
  }
}

/** Create a thread. Cloud threads get a sandbox (after the usage policy agrees); local ones are metadata only. */
export async function createThread(userId: string, workspaceId: string, req: CreateThreadRequest): Promise<ThreadResponse> {
  const id = newThreadId();
  const base = {
    id,
    workspace_id: workspaceId,
    created_by: userId,
    title: req.title?.trim() || defaultTitle(req),
    agent: req.agent,
    repo: req.repo,
    branch: branchForThread(id),
    mode: req.mode,
    sandbox_size: req.sandboxSize,
    initial_prompt: req.prompt?.trim() || null,
  };
  const db = supabaseAdmin();

  if (req.mode === "local") {
    // The desktop app runs the runner itself; the control plane only keeps the record.
    const { data, error } = await db.from("threads").insert({ ...base, status: "idle" }).select("*").single();
    if (error) throw error;
    return threadResponse(data as ThreadRow, userId);
  }

  const invalid = validateCloudLaunch(req.agent, req.repo);
  if (invalid) throw new HttpError(400, invalid);

  const { usagePolicy } = await getPlugin();
  const decision = await usagePolicy.canStartSandbox({ userId, workspaceId, threadId: id, size: req.sandboxSize });
  if (!decision.allow) throw new PolicyDeniedError(decision);

  const provider = getSandboxProvider();
  const { data: inserted, error } = await db
    .from("threads")
    .insert({ ...base, status: "provisioning", sandbox_provider: provider.name })
    .select("*")
    .single();
  if (error) throw error;

  const launch = await launchFor(inserted as ThreadRow);
  let info;
  try {
    info = await provider.create({
      threadId: id,
      size: req.sandboxSize,
      runner: launch,
      labels: { "lemonlime.workspace": workspaceId, "lemonlime.runner-port": String(RUNNER_PORT) },
    });
  } catch (err) {
    await updateRow(id, { status: "failed" });
    throw new HttpError(502, `Could not start the sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = new Date().toISOString();
  const row = await updateRow(id, {
    sandbox_id: info.id,
    runner_url: info.runnerUrl,
    running_since: now,
    idle_since: now,
    last_heartbeat_at: null,
  });
  await notify("onSandboxStarted", () => usagePolicy.onSandboxStarted(runningSandbox(row)));
  return threadResponse(row, userId);
}

function defaultTitle(req: CreateThreadRequest): string {
  const firstLine = req.prompt?.trim().split("\n")[0]?.trim();
  if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  const repo = req.repo.url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return `${req.agent.kind} on ${repo}`;
}

/**
 * End the thread's current run: pause or destroy the sandbox, then record the run
 * exactly once (the conditional update on `running_since` makes this idempotent).
 */
export async function endRun(
  row: ThreadRow,
  endReason: EndReason,
  opts: { destroy?: boolean; status?: Thread["status"] } = {},
): Promise<ThreadRow> {
  const provider = getSandboxProvider();
  if (row.sandbox_id) {
    if (opts.destroy) await provider.destroy(row.sandbox_id);
    else await provider.pause(row.sandbox_id);
  }

  const status = opts.status ?? (opts.destroy ? "stopped" : "paused");
  const patch: Partial<ThreadRow> = {
    status,
    running_since: null,
    idle_since: null,
    runner_url: null,
    ...(opts.destroy ? { sandbox_id: null } : {}),
  };
  const db = supabaseAdmin();
  const { data: claimed, error } = await db
    .from("threads")
    .update(patch)
    .eq("id", row.id)
    .not("running_since", "is", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;

  if (!claimed) {
    // Not running (already paused, or another request got here first). Destroy still marks it stopped.
    return opts.destroy ? updateRow(row.id, patch) : ((await getRow(row.id)) ?? row);
  }

  if (row.running_since && row.sandbox_id) {
    const endedAtMs = Date.now();
    const run = {
      ...runningSandbox(row),
      endedAt: new Date(endedAtMs).toISOString(),
      runtimeSeconds: runtimeSeconds(iso(row.running_since), endedAtMs),
      endReason,
    };
    const { error: runError } = await db.from("sandbox_runs").insert({
      thread_id: row.id,
      workspace_id: row.workspace_id,
      sandbox_id: row.sandbox_id,
      size: row.sandbox_size,
      started_at: run.runningSince,
      ended_at: run.endedAt,
      runtime_seconds: run.runtimeSeconds,
      end_reason: endReason,
    });
    if (runError) console.error("[lemonlime] could not record sandbox run:", runError);
    const { usagePolicy } = await getPlugin();
    await notify("onSandboxStopped", () => usagePolicy.onSandboxStopped(run));
  }
  return claimed as ThreadRow;
}

export async function pauseThread(userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(userId, id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads run on your computer and cannot be paused here.");
  if (!row.running_since) return threadResponse(row, userId);
  return threadResponse(await endRun(row, "user"), userId);
}

export async function resumeThread(userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(userId, id);
  if (row.mode !== "cloud") throw new HttpError(409, "Local threads run on your computer and cannot be resumed here.");
  if (row.running_since) return threadResponse(row, userId); // already running
  if (!row.sandbox_id || row.status === "stopped") throw new HttpError(409, "This thread's sandbox no longer exists.");

  const { usagePolicy } = await getPlugin();
  const decision = await usagePolicy.canStartSandbox({
    userId,
    workspaceId: row.workspace_id,
    threadId: row.id,
    size: row.sandbox_size,
  });
  if (!decision.allow) throw new PolicyDeniedError(decision);

  let info;
  try {
    info = await getSandboxProvider().resume(row.sandbox_id, await launchFor(row));
  } catch (err) {
    throw new HttpError(502, `Could not resume the sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = new Date().toISOString();
  const updated = await updateRow(row.id, {
    status: "provisioning",
    sandbox_id: info.id,
    runner_url: info.runnerUrl,
    running_since: now,
    idle_since: now,
    last_heartbeat_at: null,
  });
  await notify("onSandboxStarted", () => usagePolicy.onSandboxStarted(runningSandbox(updated)));
  return threadResponse(updated, userId);
}

export async function deleteThread(userId: string, id: string): Promise<ThreadResponse> {
  const row = await getThreadRowForUser(userId, id);
  if (row.mode !== "cloud") {
    return threadResponse(await updateRow(row.id, { status: "stopped" }), userId);
  }
  return threadResponse(await endRun(row, "user", { destroy: true }), userId);
}

// ─── Runner heartbeats ──────────────────────────────────────────────────────

export async function recordHeartbeat(hb: RunnerHeartbeat): Promise<HeartbeatResponse> {
  const row = await getRow(hb.threadId);
  if (!row) throw new HttpError(404, "Thread not found.");
  const latestSeq = Math.max(row.latest_seq, hb.latestSeq);
  const now = new Date().toISOString();

  // The control plane already paused or stopped this sandbox: keep our state and ask the runner to stop.
  if (row.mode === "cloud" && !row.running_since) {
    await updateRow(row.id, { latest_seq: latestSeq, last_heartbeat_at: now });
    return { action: "shutdown" };
  }

  await updateRow(row.id, {
    status: hb.status,
    latest_seq: latestSeq,
    idle_since: hb.idleSince,
    last_heartbeat_at: now,
  });
  return { action: "none" };
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

export interface SweepResult {
  checked: number;
  paused: Array<{ threadId: string; endReason: EndReason }>;
  errors: Array<{ threadId: string; error: string }>;
}

/** Pause idle, silent and no-longer-allowed cloud sandboxes. Safe to call as often as you like. */
export async function sweepRunningSandboxes(nowMs: number = Date.now()): Promise<SweepResult> {
  const { data, error } = await supabaseAdmin()
    .from("threads")
    .select("*")
    .eq("mode", "cloud")
    .not("running_since", "is", null)
    .not("sandbox_id", "is", null);
  if (error) throw error;
  const threads = (data as ThreadRow[]).map(toSweepThread);

  const { usagePolicy } = await getPlugin();
  const decision = await decideSweep(threads, nowMs, t => usagePolicy.canKeepRunning(runningSandbox(t.row)));

  const result: SweepResult = {
    checked: threads.length,
    paused: [],
    errors: decision.errors.map(e => ({ threadId: e.thread.id, error: e.error })),
  };
  for (const { thread, endReason } of decision.pause) {
    try {
      await endRun(thread.row, endReason, thread.row.status === "failed" ? { status: "failed" } : {});
      result.paused.push({ threadId: thread.id, endReason });
    } catch (err) {
      result.errors.push({ threadId: thread.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
