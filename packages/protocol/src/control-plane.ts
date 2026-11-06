import { z } from "zod";
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
});
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeat>;

export const HeartbeatResponse = z.object({
  /** The control plane may ask the runner to wind down (e.g. before a pause). */
  action: z.enum(["none", "shutdown"]).default("none"),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;
