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
});

export const ClientInterrupt = z.object({ type: z.literal("interrupt") });

/** Answer an `approval_request`. Answers for requests already decided are ignored. */
export const ClientApprove = z.object({
  type: z.literal("approve"),
  requestId: z.string().min(1).max(100),
  decision: z.enum(["allow", "deny"]),
});
export const ClientPing = z.object({ type: z.literal("ping"), t: z.number().optional() });

export const ClientMessage = z.discriminatedUnion("type", [ClientHello, ClientSendMessage, ClientInterrupt, ClientPing, ClientApprove]);
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

export const ServerMessage = z.discriminatedUnion("type", [ServerWelcome, ServerEvent, ServerCaughtUp, ServerPong, ServerError, ServerAck]);
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
