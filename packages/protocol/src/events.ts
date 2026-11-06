import { z } from "zod";
import { ThreadId, ThreadStatus } from "./thread.ts";

/** Fields every event carries. `seq` starts at 1 and increases by 1 per thread. */
const base = {
  threadId: ThreadId,
  seq: z.number().int().positive(),
  at: z.string().datetime(),
};

export const UserMessageEvent = z.object({
  ...base,
  type: z.literal("user_message"),
  text: z.string(),
  /** Id chosen by the client so it can match its optimistic message. */
  clientMsgId: z.string().optional(),
});

export const AgentMessageEvent = z.object({
  ...base,
  type: z.literal("agent_message"),
  text: z.string(),
  /** Streaming chunk of a message still being written (true) or a whole message (false). */
  partial: z.boolean().default(false),
});

export const ToolCallEvent = z.object({
  ...base,
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const ToolResultEvent = z.object({
  ...base,
  type: z.literal("tool_result"),
  callId: z.string(),
  output: z.unknown(),
  isError: z.boolean().default(false),
});

export const FileDiffEvent = z.object({
  ...base,
  type: z.literal("file_diff"),
  path: z.string(),
  change: z.enum(["added", "modified", "deleted", "renamed"]),
  /** Unified diff for this file. May be truncated for very large files. */
  diff: z.string(),
  truncated: z.boolean().default(false),
});

export const StatusChangeEvent = z.object({
  ...base,
  type: z.literal("status_change"),
  from: ThreadStatus,
  to: ThreadStatus,
  reason: z.string().optional(),
});

export const ErrorEvent = z.object({
  ...base,
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
  /** A fatal error ends the thread; a non-fatal one only ends the current turn. */
  fatal: z.boolean().default(false),
});

export const ThreadEvent = z.discriminatedUnion("type", [
  UserMessageEvent,
  AgentMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileDiffEvent,
  StatusChangeEvent,
  ErrorEvent,
]);
export type ThreadEvent = z.infer<typeof ThreadEvent>;
export type ThreadEventType = ThreadEvent["type"];
export type EventOf<T extends ThreadEventType> = Extract<ThreadEvent, { type: T }>;

type ThreadEventInput = z.input<typeof ThreadEvent>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the store assigns `threadId`, `seq` and `at` (defaulted fields optional). */
export type NewEvent = DistributiveOmit<ThreadEventInput, "threadId" | "seq" | "at">;
