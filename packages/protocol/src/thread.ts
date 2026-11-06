import { z } from "zod";

/** Agents LemonLime knows how to drive. `acp` covers any Agent Client Protocol agent. */
export const AgentKind = z.enum(["claude-code", "codex", "opencode", "acp"]);
export type AgentKind = z.infer<typeof AgentKind>;

export const ThreadMode = z.enum(["local", "cloud"]);
export type ThreadMode = z.infer<typeof ThreadMode>;

/**
 * Lifecycle of a thread.
 * - provisioning: sandbox is being created (cloud only)
 * - idle:        runner is up, agent is waiting for a message
 * - running:     agent is working on a turn
 * - paused:      sandbox is paused (no compute); resumes on demand
 * - stopped:     thread was closed by the user
 * - failed:      unrecoverable error
 */
export const ThreadStatus = z.enum(["provisioning", "idle", "running", "paused", "stopped", "failed"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const SandboxSize = z.enum(["small", "large"]);
export type SandboxSize = z.infer<typeof SandboxSize>;

/** Resources for each sandbox size. Kept here so every component agrees. */
export const SANDBOX_RESOURCES: Record<SandboxSize, { vcpu: number; memoryGiB: number; diskGiB: number }> = {
  small: { vcpu: 1, memoryGiB: 2, diskGiB: 10 },
  large: { vcpu: 2, memoryGiB: 4, diskGiB: 10 },
};

/** A paused-on-idle threshold that every deployment shares. */
export const IDLE_PAUSE_AFTER_MS = 5 * 60 * 1000;

/** Thread ids are lowercase, URL- and branch-safe. */
export const ThreadId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{5,63}$/, "thread id must be 6-64 chars of a-z, 0-9 or -");
export type ThreadId = z.infer<typeof ThreadId>;

export const RepoRef = z.object({
  /** Clone URL (cloud) or absolute path on disk (local). */
  url: z.string().min(1),
  /** Branch the agent branch is created from. */
  baseBranch: z.string().min(1).default("main"),
});
export type RepoRef = z.infer<typeof RepoRef>;

/** Extra launch options for an agent. Only `acp` requires `command`. */
export const AgentConfig = z.object({
  kind: AgentKind,
  /** Command + args for ACP agents, e.g. ["opencode", "acp"]. */
  command: z.array(z.string()).optional(),
  model: z.string().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

export const Thread = z.object({
  id: ThreadId,
  title: z.string().max(200).default(""),
  agent: AgentConfig,
  repo: RepoRef,
  branch: z.string(),
  mode: ThreadMode,
  status: ThreadStatus,
  sandboxSize: SandboxSize.default("small"),
  /** Highest event seq the control plane has seen (cloud) or the runner holds (local). */
  latestSeq: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Thread = z.infer<typeof Thread>;

/** Every thread works on its own branch. */
export function branchForThread(id: ThreadId): string {
  return `agent/${id}`;
}

/** Generates a sortable, branch-safe thread id: base36 time + random suffix. */
export function newThreadId(now: number = Date.now()): ThreadId {
  const time = now.toString(36).padStart(9, "0");
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, b => (b % 36).toString(36)).join("");
  return `${time}-${rand}`;
}
