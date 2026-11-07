import { z } from "zod";
import { ThreadEvent } from "./events.ts";
import { Thread } from "./thread.ts";

/**
 * Messages on the WebSocket between a client (desktop or web) and a runner.
 * The client authenticates in its first message, then may resume from any seq.
 */

export const ClientHello = z.object({
  type: z.literal("hello"),
  /** Runner token issued by the control plane (cloud) or the desktop app (local). */
  token: z.string().min(1),
  /** Send every event with seq > resumeFrom. 0 replays the whole history. */
  resumeFrom: z.number().int().nonnegative().default(0),
});

export const ClientSendMessage = z.object({
  type: z.literal("send_message"),
  text: z.string().min(1).max(200_000),
  /**
   * Request id chosen by the client. Sending the same id again never starts a second
   * turn, so clients can safely resend anything not yet acknowledged after a reconnect.
   */
  clientMsgId: z.string().min(1).max(100).optional(),
  /** Ids of finished uploads (POST/PUT /attachments on the runner) sent with it. */
  attachments: z.array(z.string().max(64)).max(20).optional(),
});

export const ClientInterrupt = z.object({ type: z.literal("interrupt") });

/** Answer an `approval_request`. Answers for requests already decided are ignored. */
export const ClientApprove = z.object({
  type: z.literal("approve"),
  requestId: z.string().min(1).max(100),
  decision: z.enum(["allow", "deny"]),
});
export const ClientPing = z.object({ type: z.literal("ping"), t: z.number().optional() });

/**
 * Change a message waiting in the queue: `update` its text, `remove` it, `move` it to
 * `toIndex`, or `send_now` (steer): stop the current turn and run it next. Messages that
 * already started can't be changed; the answer is the next `queue_update`.
 */
export const ClientEditQueue = z.object({
  type: z.literal("edit_queue"),
  action: z.enum(["update", "remove", "move", "send_now"]),
  clientMsgId: z.string().min(1).max(100),
  /** New text, for `update`. */
  text: z.string().min(1).max(200_000).optional(),
  /** New position (0 = next), for `move`. */
  toIndex: z.number().int().min(0).max(10_000).optional(),
});
export type ClientEditQueue = z.infer<typeof ClientEditQueue>;

/** Go back to the user message at `toSeq` (see RewindEvent); optionally put files back too. */
export const ClientRewind = z.object({ type: z.literal("rewind"), toSeq: z.number().int().positive(), restoreFiles: z.boolean().default(false) });
/** Ask the agent to shrink its conversation (agents that support it). */
export const ClientCompact = z.object({ type: z.literal("compact") });

/**
 * Side chats: questions about the thread answered by a separate, read-only agent
 * conversation, kept out of the thread's history. `side_ask` without `sideId` starts one.
 * Unpinned chats are discarded when closed.
 */
export const ClientSideAsk = z.object({
  type: z.literal("side_ask"),
  text: z.string().min(1).max(200_000),
  sideId: z.string().max(100).optional(),
  requestId: z.string().max(100).optional(),
});
export const ClientSidePin = z.object({ type: z.literal("side_pin"), sideId: z.string().max(100), pinned: z.boolean() });
export const ClientSideClose = z.object({ type: z.literal("side_close"), sideId: z.string().max(100) });
/** Ask for a side chat's messages so far (answered with `side_history`). */
export const ClientSideOpen = z.object({ type: z.literal("side_open"), sideId: z.string().max(100) });

/**
 * Sign the agent in to the user's own model account (cloud sandboxes). Login traffic uses
 * these messages only and never becomes part of the thread's history.
 */
export const ClientStartLogin = z.object({ type: z.literal("start_login") });
/** Text the user was asked for during sign-in, e.g. the code Claude shows after authorizing. */
export const ClientLoginInput = z.object({ type: z.literal("login_input"), text: z.string().min(1).max(10_000) });
export const ClientCancelLogin = z.object({ type: z.literal("cancel_login") });

export const ClientMessage = z.discriminatedUnion("type", [
  ClientHello,
  ClientSendMessage,
  ClientInterrupt,
  ClientPing,
  ClientApprove,
  ClientStartLogin,
  ClientLoginInput,
  ClientCancelLogin,
  ClientEditQueue,
  ClientRewind,
  ClientCompact,
  ClientSideAsk,
  ClientSidePin,
  ClientSideClose,
  ClientSideOpen,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerWelcome = z.object({
  type: z.literal("welcome"),
  thread: Thread,
  latestSeq: z.number().int().nonnegative(),
  runnerVersion: z.string(),
});

export const ServerEvent = z.object({ type: z.literal("event"), event: ThreadEvent });

/** Sent after the replay so clients know they are now live. */
export const ServerCaughtUp = z.object({ type: z.literal("caught_up"), latestSeq: z.number().int().nonnegative() });

export const ServerPong = z.object({ type: z.literal("pong"), t: z.number().optional() });

/**
 * Reply to `send_message`: the message started a turn, joined the queue, or was a
 * repeat of one the runner already has (nothing new happens).
 */
export const ServerAck = z.object({
  type: z.literal("ack"),
  clientMsgId: z.string(),
  result: z.enum(["started", "queued", "duplicate"]),
});

export const ServerError = z.object({
  type: z.literal("error"),
  /** `busy` is no longer sent (messages queue instead); kept so older clients still parse. */
  code: z.enum(["unauthorized", "bad_request", "busy", "internal"]),
  message: z.string(),
});

/**
 * Where a sign-in stands. `open_url`: send the user to `url` (and show `code` if given);
 * `needs_input`: they paste what the page showed them; then `done` or `failed`.
 * Sent to connected clients only, never stored.
 */
export const ServerLogin = z.object({
  type: z.literal("login"),
  state: z.enum(["starting", "open_url", "needs_input", "done", "failed"]),
  url: z.string().url().optional(),
  code: z.string().max(100).optional(),
  message: z.string().max(2000).optional(),
});

export const SideChatSummary = z.object({ id: z.string(), title: z.string(), pinned: z.boolean(), createdAt: z.string(), busy: z.boolean() });
export type SideChatSummary = z.infer<typeof SideChatSummary>;
/** The side chats this thread has; sent after `caught_up` and whenever they change. */
export const ServerSideChats = z.object({ type: z.literal("side_chats"), chats: z.array(SideChatSummary) });
export const ServerSideEvent = z.object({ type: z.literal("side_event"), sideId: z.string(), event: ThreadEvent });
export const ServerSideHistory = z.object({ type: z.literal("side_history"), sideId: z.string(), events: z.array(ThreadEvent) });
/** A `side_ask` was taken: `sideId` is the chat it went to (new, if none was given). */
export const ServerSideStarted = z.object({ type: z.literal("side_started"), sideId: z.string(), requestId: z.string().optional() });

export const ServerMessage = z.discriminatedUnion("type", [
  ServerWelcome,
  ServerEvent,
  ServerCaughtUp,
  ServerPong,
  ServerError,
  ServerAck,
  ServerLogin,
  ServerSideChats,
  ServerSideEvent,
  ServerSideHistory,
  ServerSideStarted,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Parse a raw WebSocket frame. Returns null instead of throwing on bad input. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const r = ClientMessage.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const r = ServerMessage.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
