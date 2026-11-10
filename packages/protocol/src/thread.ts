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
/** Background work (builds, downloads, dev servers) keeps an idle sandbox awake this long at most. */
export const BACKGROUND_KEEP_AWAKE_MS = 2 * 60 * 60 * 1000;
/** How long the control plane waits for a runner to drain before pausing anyway. */
export const DRAIN_TIMEOUT_MS = 60 * 1000;

/** Thread ids are lowercase, URL- and branch-safe. */
export const ThreadId = z.string().regex(/^[a-z0-9][a-z0-9-]{5,63}$/, "thread id must be 6-64 chars of a-z, 0-9 or -");
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
  /** How hard the agent thinks, for agents that offer it (see AGENT_CAPABILITIES). */
  reasoning: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  /** Start in the agent's fast mode, for agents that have one. */
  fast: z.boolean().optional(),
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
  /**
   * Whether the person asking started this thread. In a workspace, only they can direct
   * its agent and reach its sandbox, unless they share the thread; everyone else in the
   * workspace reads along.
   */
  mine: z.boolean().default(true),
  /** The person who started this thread lets the rest of the workspace take part in it. */
  shared: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Thread = z.infer<typeof Thread>;

/** True when the person asking may send messages, answer the agent and open the sandbox. */
export function canTakePart(thread: Pick<Thread, "mine" | "shared">): boolean {
  return thread.mine || thread.shared;
}

/** What thread branches start with unless the user picks something else (local threads). */
export const DEFAULT_BRANCH_PREFIX = "agent/";

/**
 * A prefix for thread branch names, e.g. "agent/", "ai/" or "lemonlime-". It must make a
 * valid git branch name with any thread id after it: letters, digits, ".", "_", "-" and
 * "/" between parts, no part starting with "." or ending in ".lock", no "..", "//" or "@{".
 */
export const BranchPrefix = z
  .string()
  .max(100)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\/?$/, "branch prefix can use letters, digits, . _ - and / between parts")
  .refine(p => !p.includes("..") && !p.split("/").some(part => part.endsWith(".lock") || part.endsWith(".")), "branch prefix is not a valid git branch name");
export type BranchPrefix = z.infer<typeof BranchPrefix>;

export function isSafeBranchPrefix(prefix: string): boolean {
  return BranchPrefix.safeParse(prefix).success;
}

/** Every thread works on its own branch: `agent/<id>` unless a (validated) prefix is given. */
export function branchForThread(id: ThreadId, prefix: string = DEFAULT_BRANCH_PREFIX): string {
  if (!isSafeBranchPrefix(prefix)) throw new Error(`"${prefix}" is not a safe branch prefix`);
  return `${prefix}${id}`;
}

/** Generates a sortable, branch-safe thread id: base36 time + random suffix. */
export function newThreadId(now: number = Date.now()): ThreadId {
  const time = now.toString(36).padStart(9, "0");
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, b => (b % 36).toString(36)).join("");
  return `${time}-${rand}`;
}
