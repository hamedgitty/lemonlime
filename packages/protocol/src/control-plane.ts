import { z } from "zod";
import { ThreadEvent } from "./events.ts";
import { AgentConfig, RepoRef, SandboxSize, Thread, ThreadId, ThreadMode, ThreadStatus } from "./thread.ts";

/** HTTP API between clients and the control plane, and between runners and the control plane. */

export const CreateThreadRequest = z.object({
  title: z.string().max(200).optional(),
  agent: AgentConfig,
  repo: RepoRef,
  mode: ThreadMode,
  sandboxSize: SandboxSize.default("small"),
  /** First message to send once the runner is up. */
  prompt: z.string().max(200_000).optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

/** Where a client should connect for the live session. */
export const RunnerEndpoint = z.object({
  url: z.string().url(),
  token: z.string(),
  expiresAt: z.string().datetime(),
});
export type RunnerEndpoint = z.infer<typeof RunnerEndpoint>;

export const ThreadWithEndpoint = z.object({
  thread: Thread,
  endpoint: RunnerEndpoint.nullable(),
});
export type ThreadWithEndpoint = z.infer<typeof ThreadWithEndpoint>;

/** Returned when a plugin declines an action, e.g. starting a sandbox. */
export const PolicyDenied = z.object({
  error: z.literal("policy_denied"),
  reason: z.string(),
  /** Optional link the UI can show next to the reason. */
  actionUrl: z.string().url().optional(),
  actionLabel: z.string().optional(),
});
export type PolicyDenied = z.infer<typeof PolicyDenied>;

/** Runner → control plane, every ~30 s and on every status change. */
export const RunnerHeartbeat = z.object({
  threadId: ThreadId,
  status: ThreadStatus,
  latestSeq: z.number().int().nonnegative(),
  /** ISO time the agent last finished work, or null while running. */
  idleSince: z.string().datetime().nullable(),
  runnerVersion: z.string(),
  /**
   * Work still going on in the sandbox after the agent's turn ended: a build or test
   * using the CPU, a download, or a dev server listening for connections. Keeps an idle
   * sandbox awake for up to `BACKGROUND_KEEP_AWAKE_MS`. Housekeeping doesn't count.
   */
  background: z.enum(["build", "download", "server"]).nullable().optional(),
  /** True once the runner has finished a `drain`: history uploaded, state saved. */
  drained: z.boolean().optional(),
  /**
   * CPU in use across the sandbox since the last heartbeat (in cores) and the program
   * using the most. Reported as measured inside the sandbox, so treat it as a hint.
   */
  load: z
    .object({
      cpuCores: z.number().nonnegative().max(1024),
      topProcess: z.string().max(64).nullable(),
    })
    .optional(),
});
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeat>;

export const HeartbeatResponse = z.object({
  /**
   * `drain`: the sandbox is about to be paused; upload history, save state and say
   * `drained: true` in the next heartbeat. `shutdown`: stop now.
   */
  action: z.enum(["none", "drain", "shutdown"]).default("none"),
  /** Messages waiting for this thread at the control plane (sent while it was paused). */
  pendingMessages: z.number().int().nonnegative().default(0),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** Runner → control plane: the next part of the thread's history, to keep after the sandbox is gone. */
export const RunnerHistoryUpload = z.object({
  threadId: ThreadId,
  /** Consecutive events, oldest first, continuing from what the control plane has. */
  events: z.array(ThreadEvent).min(1).max(2000),
});
export type RunnerHistoryUpload = z.infer<typeof RunnerHistoryUpload>;

/** How much history the control plane now holds; the runner sends from `storedSeq + 1` next. */
export const RunnerHistoryResponse = z.object({ storedSeq: z.number().int().nonnegative() });
export type RunnerHistoryResponse = z.infer<typeof RunnerHistoryResponse>;

/** A message sent to a thread whose sandbox was paused; the runner picks it up when it wakes. */
export const PendingMessage = z.object({
  clientMsgId: z.string().min(1).max(100),
  text: z.string().min(1).max(200_000),
});
export type PendingMessage = z.infer<typeof PendingMessage>;

/** Runner ← control plane: messages waiting for this thread. */
export const RunnerInbox = z.object({ messages: z.array(PendingMessage) });
export type RunnerInbox = z.infer<typeof RunnerInbox>;

/** Runner → control plane: these messages are now in the runner's queue or history. */
export const RunnerInboxAck = z.object({ threadId: ThreadId, clientMsgIds: z.array(z.string()).max(1000) });
export type RunnerInboxAck = z.infer<typeof RunnerInboxAck>;

/** Client → control plane: the thread's stored history (for paused threads; no sandbox needed). */
export const ThreadHistoryResponse = z.object({
  events: z.array(ThreadEvent),
  /** True when more events follow; ask again with `after` = the last seq. */
  more: z.boolean(),
});
export type ThreadHistoryResponse = z.infer<typeof ThreadHistoryResponse>;

/**
 * Runner → control plane: the credential an agent produced when the user signed it in
 * inside a sandbox, kept (encrypted) so the user's next sandboxes start signed in.
 * `env`: an environment variable (e.g. CLAUDE_CODE_OAUTH_TOKEN). `file`: a file under the
 * agent user's home directory (e.g. .codex/auth.json).
 */
/**
 * The only credentials that may be saved, per agent. Anything else is refused: code in a
 * sandbox can reach this endpoint, and a saved value lands in every later sandbox, so an
 * open list would let it plant e.g. NODE_OPTIONS in all of them.
 */
export const AGENT_CREDENTIALS = {
  "claude-code": [{ kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN" }],
  codex: [{ kind: "file", name: ".codex/auth.json" }],
  opencode: [],
} as const satisfies Record<string, readonly { kind: "env" | "file"; name: string }[]>;

export function isAllowedAgentCredential(agent: string, kind: string, name: string): boolean {
  const list: readonly { kind: string; name: string }[] = AGENT_CREDENTIALS[agent as keyof typeof AGENT_CREDENTIALS] ?? [];
  return list.some(c => c.kind === kind && c.name === name);
}

export const AgentCredentialUpload = z
  .object({
    threadId: ThreadId,
    agent: z.enum(["claude-code", "codex", "opencode"]),
    kind: z.enum(["env", "file"]),
    /** Variable name, or path relative to the home directory. One of AGENT_CREDENTIALS. */
    name: z.string().min(1).max(200),
    value: z.string().min(1).max(64_000),
  })
  .refine(c => isAllowedAgentCredential(c.agent, c.kind, c.name), { message: "Not a credential this agent uses.", path: ["name"] });
export type AgentCredentialUpload = z.infer<typeof AgentCredentialUpload>;
