import { z } from "zod";
import { AgentKind, ThreadId, ThreadStatus } from "./thread.ts";
import { signClaims, verifyClaims } from "./token.ts";

/**
 * Phone access: driving the threads that run on your own computer from the web dashboard
 * on your phone, when you turn it on. See docs/phone-access.md for the whole design.
 *
 *   phone ──wss──▶ control plane (phone bridge) ◀──wss── desktop app ──ws (loopback)──▶ runner
 *
 * The desktop app keeps one outbound "link" to the bridge while the setting is on. The
 * phone opens a WebSocket to the bridge for one thread and speaks the normal runner
 * protocol; the bridge pipes its frames over the link, and the desktop app pipes them to
 * the thread's runner on this computer with a `phone` token it signs itself. The thread
 * secret never leaves the computer.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Biggest frame a phone may send (a message, an answer). Bigger ones close its connection. */
export const PHONE_FRAME_MAX_BYTES = 256 * 1024;
/** Biggest frame the desktop app may send over its link (an event from the runner, wrapped). */
export const LINK_FRAME_MAX_BYTES = 4 * 1024 * 1024;
/** Phones connected to one thread at once. */
export const MAX_PHONES_PER_THREAD = 3;
/** Phone connections to one computer at once, over all its threads. */
export const MAX_PHONES_PER_COMPUTER = 12;
/** A phone connection with no frames either way for this long is closed (the app reconnects). */
export const PHONE_IDLE_MS = 5 * 60_000;
/** The desktop app pings its link this often... */
export const LINK_PING_MS = 30_000;
/** ...and a link silent for this long is taken for dead. */
export const LINK_IDLE_MS = 90_000;
/** Time to send the first (authenticating) frame after connecting. */
export const BRIDGE_HELLO_MS = 10_000;
/** Phone tickets last as long as client tokens do; the connection closes when one runs out. */
export const PHONE_TICKET_SECONDS = 15 * 60;
/** Link tickets too; the desktop app renews its ticket on the open link before then. */
export const LINK_TICKET_SECONDS = 15 * 60;

/** Close codes the bridge uses (the 4001 for an expired token matches the runner's). */
export const BRIDGE_CLOSE = {
  tokenExpired: 4001,
  unauthorized: 4401,
  /** Phone access was turned off on the computer. */
  turnedOff: 4403,
  /** The computer isn't connected. */
  offline: 4404,
  /** Too many connections to this thread or computer. */
  busy: 4429,
  idle: 4408,
  /** A newer link from the same computer took over. */
  replaced: 4409,
  tooBig: 1009,
} as const;

/** The literal ping the desktop app sends on its link, answered without waking the bridge. */
export const LINK_PING = '{"type":"ping"}';
export const LINK_PONG = '{"type":"pong"}';

// ─── What the computer shares about its threads ──────────────────────────────

/**
 * What the dashboard knows about one local thread, sent by the desktop app while phone
 * access is on: enough to list it and show its last known state. Never paths or history.
 */
export const LocalThreadSnapshot = z.object({
  id: ThreadId,
  title: z.string().max(200),
  agent: z.object({ kind: AgentKind, model: z.string().max(100).optional() }),
  /** The repository folder's name only, never its path. */
  repoName: z.string().max(200),
  branch: z.string().max(300),
  status: ThreadStatus,
  latestSeq: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LocalThreadSnapshot = z.infer<typeof LocalThreadSnapshot>;

/** Most local threads a computer shares. */
export const MAX_SHARED_THREADS = 200;

export const ComputerPlatform = z.enum(["mac", "windows", "linux", "other"]);
export type ComputerPlatform = z.infer<typeof ComputerPlatform>;

export const ComputerId = z.string().regex(/^[a-z0-9-]{16,64}$/, "computer id must be 16-64 chars of a-z, 0-9 or -");

/** `PUT /api/computers/:id`: the desktop app says who it is and whether phone access is on. */
export const ComputerUpdate = z.object({
  name: z.string().trim().min(1).max(100),
  platform: ComputerPlatform.default("other"),
  phoneAccess: z.boolean(),
  /** Replaces the shared thread list (ignored while phone access is off). */
  threads: z.array(LocalThreadSnapshot).max(MAX_SHARED_THREADS).optional(),
});
export type ComputerUpdate = z.infer<typeof ComputerUpdate>;

// ─── Tickets ─────────────────────────────────────────────────────────────────

/**
 * Tickets are signed by the control plane with a key derived from its master secret and
 * checked by the bridge, which never touches the database. `epoch` changes every time
 * phone access is turned off, so tickets handed out before then stop working.
 */
export const BridgeTicket = z.discriminatedUnion("kind", [
  /** Lets the desktop app open (or renew) its computer's link. */
  z.object({
    kind: z.literal("link"),
    computerId: ComputerId,
    userId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  }),
  /** Lets a phone open one thread on one computer, as one user. */
  z.object({
    kind: z.literal("phone"),
    computerId: ComputerId,
    threadId: ThreadId,
    userId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  }),
]);
export type BridgeTicket = z.infer<typeof BridgeTicket>;

/** The bridge's signing key, derived from the master secret; never the secret itself. */
export async function deriveBridgeKey(masterSecret: string): Promise<string> {
  const enc = new TextEncoder();
  if (masterSecret.length < 16) throw new Error("token secret must be at least 16 characters");
  const key = await crypto.subtle.importKey("raw", enc.encode(masterSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("lemonlime-phone-bridge")));
  let s = "";
  for (const b of mac) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signBridgeTicket(ticket: BridgeTicket, key: string): Promise<string> {
  return signClaims(BridgeTicket.parse(ticket), key);
}

/** The ticket, if it is well signed, unexpired and no longer-lived than any ticket the control plane makes. */
export async function verifyBridgeTicket(token: string, key: string, nowSec = Math.floor(Date.now() / 1000)): Promise<BridgeTicket | null> {
  const claims = await verifyClaims(token, key);
  const parsed = BridgeTicket.safeParse(claims);
  if (!parsed.success) return null;
  const longest = parsed.data.kind === "link" ? LINK_TICKET_SECONDS : PHONE_TICKET_SECONDS;
  if (parsed.data.exp <= nowSec || parsed.data.exp > nowSec + longest + 60) return null;
  return parsed.data;
}

// ─── The link between the bridge and the desktop app ─────────────────────────

/** Bridge → desktop app. */
export const LinkDown = z.discriminatedUnion("type", [
  /** The link is accepted. */
  z.object({ type: z.literal("linked") }),
  /** A phone wants this thread. Answer with frames for `session`, or `end` it. */
  z.object({ type: z.literal("open"), session: z.string().min(1).max(64), threadId: ThreadId, userId: z.string().min(1), exp: z.number().int().positive() }),
  /** A frame from the phone, verbatim (the first is its hello, with the ticket taken out). */
  z.object({ type: z.literal("data"), session: z.string().min(1).max(64), data: z.string() }),
  /** The phone went away. */
  z.object({ type: z.literal("end"), session: z.string().min(1).max(64) }),
  z.object({ type: z.literal("pong") }),
]);
export type LinkDown = z.infer<typeof LinkDown>;

/** Desktop app → bridge. */
export const LinkUp = z.discriminatedUnion("type", [
  /** First frame on a new link. */
  z.object({ type: z.literal("auth"), ticket: z.string().min(1).max(4096) }),
  /** A fresh link ticket, sent before the current one runs out. */
  z.object({ type: z.literal("renew"), ticket: z.string().min(1).max(4096) }),
  /** A frame from the runner for the phone, verbatim. */
  z.object({ type: z.literal("data"), session: z.string().min(1).max(64), data: z.string() }),
  /** Close the phone's connection (with the runner's close code, if it closed). */
  z.object({ type: z.literal("end"), session: z.string().min(1).max(64), code: z.number().int().optional(), reason: z.string().max(120).optional() }),
  z.object({ type: z.literal("ping") }),
]);
export type LinkUp = z.infer<typeof LinkUp>;

function parseWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export const parseLinkDown = (raw: string): LinkDown | null => parseWith(LinkDown, raw);
export const parseLinkUp = (raw: string): LinkUp | null => parseWith(LinkUp, raw);

/** Bytes in a frame as sent (UTF-8). */
export function frameBytes(data: string): number {
  // Fast path: a string can't take more than 3 bytes per UTF-16 unit.
  if (data.length * 3 <= PHONE_FRAME_MAX_BYTES) return data.length;
  return new TextEncoder().encode(data).length;
}
