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
 *
 * The bridge only carries frames. What is in them is sealed between the phone and the
 * computer with a pairing key the control plane never sees (see "Pairing" and "Sealed
 * sessions" below), so the control plane can neither read a session nor add to it.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Biggest frame a phone may send; bigger ones close its connection. Also the biggest whole
 * message (one that was split over several sealed frames) the computer takes from a phone.
 */
export const PHONE_FRAME_MAX_BYTES = 256 * 1024;
/**
 * Biggest frame the desktop app may send over its link (a frame for a phone, wrapped). Also
 * the biggest whole message from the runner that the computer sends to a phone.
 */
export const LINK_FRAME_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Most bytes of a message in one sealed frame. Sealed and encoded, a frame this full is
 * about 171 KiB, so it fits a phone's frame limit; longer messages go as several frames.
 */
export const SEAL_CHUNK_BYTES = 128 * 1024;
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
  /** The computer only answers phones paired with it, and this one isn't (or no longer is). */
  notPaired: 4412,
  tooBig: 1009,
} as const;

/**
 * The reason sent with `notPaired`, in words the dashboard can show. A bridge that doesn't
 * know the code still passes the reason on, so the phone recognises either.
 */
export const NOT_PAIRED_REASON = "Pair this phone with your computer";

/** Whether a phone's connection was closed because the computer doesn't accept its pairing. */
export function isNotPairedClose(code: number | undefined, reason: string | undefined): boolean {
  return code === BRIDGE_CLOSE.notPaired || reason === NOT_PAIRED_REASON;
}

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
  /**
   * This app only answers phones paired with it, and seals every session. Apps from before
   * pairing don't say; the dashboard treats that as "not sealed".
   */
  sealed: z.boolean().optional(),
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

// ─── Pairing ─────────────────────────────────────────────────────────────────

/**
 * A phone is paired with a computer when its browser holds the computer's pairing key: 32
 * random bytes the desktop app makes and keeps with its other secrets. The app shows the
 * key as a link (and a QR code of it):
 *
 *   <control plane URL>/phone/pair#v1.<computer id>.<key, base64url>
 *
 * Everything after the `#` is the fragment, which a browser never sends to a server. The
 * page at that address runs in the phone's browser, keeps the key there and clears the
 * address bar. One key per computer: every paired phone holds the same one, and making a
 * new key unpairs them all.
 */
export const PAIRING_KEY_BYTES = 32;
export const PAIRING_PATH = "/phone/pair";

export interface Pairing {
  computerId: string;
  /** The pairing key, base64url. */
  key: string;
}

const enc = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  let bin: string;
  try {
    bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomB64url(bytes: number): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A new pairing key. */
export function newPairingKey(): string {
  return randomB64url(PAIRING_KEY_BYTES);
}

/** The key as it is always written, or null if the text isn't a pairing key. */
export function normalizePairingKey(text: string): string | null {
  const bytes = fromB64url(text);
  return bytes && bytes.length === PAIRING_KEY_BYTES ? toB64url(bytes) : null;
}

/** The link the desktop app shows. `baseUrl` is the control plane's address. */
export function pairingLink(baseUrl: string, pairing: Pairing): string {
  return `${baseUrl.replace(/\/+$/, "")}${PAIRING_PATH}#v1.${pairing.computerId}.${pairing.key}`;
}

/** What a pairing link (or just its fragment) holds; null unless it is complete and well formed. */
export function parsePairingLink(link: string): Pairing | null {
  const hash = link.indexOf("#");
  const parts = (hash === -1 ? link : link.slice(hash + 1)).split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const computerId = ComputerId.safeParse(parts[1]);
  const key = normalizePairingKey(parts[2]!);
  return computerId.success && key ? { computerId: computerId.data, key } : null;
}

// ─── Sealed sessions ─────────────────────────────────────────────────────────

/**
 * Inside the frames the bridge pipes, per phone connection:
 *
 *   phone    → {"type":"e2e_hello","v":1,"nonce":"<16 random bytes>"}
 *   computer → {"type":"e2e_hello","v":1,"nonce":"<16 random bytes>"}
 *   both, from then on → {"type":"e2e","n":<counter>,"c":"<sealed bytes>"}
 *
 * Each direction has its own AES-256-GCM key, derived with HKDF-SHA256 from the pairing key,
 * salted with both nonces and bound to the computer and the thread. So frames only open in
 * the session, the thread and the direction they were sealed for, and only by someone who
 * holds the pairing key. A direction's counter starts at 0 and each frame must carry exactly
 * the next number, so a frame can't be replayed, dropped or moved without the session ending.
 *
 * A message longer than SEAL_CHUNK_BYTES goes as several frames. The first byte under the
 * seal says whether more of the message follows, so that can't be changed either.
 */
export const SealHello = z.object({
  type: z.literal("e2e_hello"),
  v: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
export type SealHello = z.infer<typeof SealHello>;

export const SealedFrame = z.object({
  type: z.literal("e2e"),
  n: z.number().int().nonnegative(),
  c: z.string().min(1),
});
export type SealedFrame = z.infer<typeof SealedFrame>;

export const parseSealHello = (raw: string): SealHello | null => parseWith(SealHello, raw);
export const parseSealedFrame = (raw: string): SealedFrame | null => parseWith(SealedFrame, raw);

/** This end's hello, with a nonce nobody has used before. */
export function newSealHello(): SealHello {
  return { type: "e2e_hello", v: 1, nonce: randomB64url(16) };
}

export type SealSide = "phone" | "computer";

export interface SealSession {
  /** The pairing key, base64url. */
  key: string;
  computerId: string;
  threadId: string;
  /** The nonce from each end's hello. */
  phoneNonce: string;
  computerNonce: string;
  /** Which end this is. */
  side: SealSide;
}

/** A frame wasn't sealed for this session, wasn't the next one, or the message is too big. */
export class SealError extends Error {}

const SEAL_LABEL = "lemonlime phone e2e v1";
const SEAL_DIRECTION: Record<SealSide, string> = { phone: "phone to computer", computer: "computer to phone" };
const MORE = 1;
const LAST = 0;

/** The biggest whole message one end may send the other, in bytes. */
export function sealedMessageMaxBytes(from: SealSide): number {
  return from === "phone" ? PHONE_FRAME_MAX_BYTES : LINK_FRAME_MAX_BYTES;
}

/**
 * One end of a sealed session. `seal` and `open` each work through their frames in the
 * order they were called, so counters always match the order frames are sent and arrive in.
 */
export class SealedChannel {
  private sent = 0;
  private received = 0;
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private broken = false;
  private sealing: Promise<unknown> = Promise.resolve();
  private opening: Promise<unknown> = Promise.resolve();

  private readonly side: SealSide;
  private readonly sendKey: CryptoKey;
  private readonly receiveKey: CryptoKey;

  private constructor(side: SealSide, sendKey: CryptoKey, receiveKey: CryptoKey) {
    this.side = side;
    this.sendKey = sendKey;
    this.receiveKey = receiveKey;
  }

  /** Derive this session's keys. Rejects when the key or a nonce isn't well formed. */
  static async start(session: SealSession): Promise<SealedChannel> {
    const key = fromB64url(session.key);
    const phoneNonce = fromB64url(session.phoneNonce);
    const computerNonce = fromB64url(session.computerNonce);
    if (!key || key.length !== PAIRING_KEY_BYTES) throw new SealError("not a pairing key");
    if (!phoneNonce || !computerNonce || phoneNonce.length !== 16 || computerNonce.length !== 16) throw new SealError("not a session nonce");
    const salt = new Uint8Array(32);
    salt.set(phoneNonce, 0);
    salt.set(computerNonce, 16);
    const base = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveKey"]);
    const derive = (from: SealSide, usage: KeyUsage) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: enc.encode([SEAL_LABEL, session.computerId, session.threadId, SEAL_DIRECTION[from]].join("\n")) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        [usage],
      );
    const other: SealSide = session.side === "phone" ? "computer" : "phone";
    return new SealedChannel(session.side, await derive(session.side, "encrypt"), await derive(other, "decrypt"));
  }

  /** Seal one message as the frames to send, in order. */
  seal(message: string): Promise<string[]> {
    const next = this.sealing.then(() => this.sealNext(message));
    this.sealing = next.catch(() => undefined);
    return next;
  }

  /**
   * Open the next frame from the other end. Resolves with a whole message, or null when the
   * frame was part of one that isn't complete yet. Rejects when the frame isn't the next one
   * sealed for this session; nothing opens after that.
   */
  open(frame: string): Promise<string | null> {
    const next = this.opening.then(() => this.openNext(frame));
    this.opening = next.catch(() => undefined);
    return next;
  }

  private async sealNext(message: string): Promise<string[]> {
    const bytes = enc.encode(message);
    if (bytes.length > sealedMessageMaxBytes(this.side)) throw new SealError("message too big");
    const frames: string[] = [];
    let at = 0;
    do {
      const chunk = bytes.subarray(at, at + SEAL_CHUNK_BYTES);
      at += chunk.length;
      const plain = new Uint8Array(chunk.length + 1);
      plain[0] = at < bytes.length ? MORE : LAST;
      plain.set(chunk, 1);
      const n = this.sent++;
      const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: counterIv(n), additionalData: sealContext(this.side, n) }, this.sendKey, plain);
      frames.push(JSON.stringify({ type: "e2e", n, c: toB64url(new Uint8Array(sealed)) } satisfies SealedFrame));
    } while (at < bytes.length);
    return frames;
  }

  private async openNext(raw: string): Promise<string | null> {
    if (this.broken) throw new SealError("the session has ended");
    try {
      return await this.openFrame(raw);
    } catch (err) {
      this.broken = true;
      this.parts = [];
      throw err instanceof SealError ? err : new SealError("the frame doesn't open");
    }
  }

  private async openFrame(raw: string): Promise<string | null> {
    const frame = parseSealedFrame(raw);
    if (!frame) throw new SealError("not a sealed frame");
    if (frame.n !== this.received) throw new SealError("not the next frame");
    const sealed = fromB64url(frame.c);
    if (!sealed) throw new SealError("not a sealed frame");
    const from: SealSide = this.side === "phone" ? "computer" : "phone";
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: counterIv(frame.n), additionalData: sealContext(from, frame.n) }, this.receiveKey, sealed),
    );
    this.received += 1;
    const more = plain[0];
    if (more !== MORE && more !== LAST) throw new SealError("not a sealed frame");
    this.parts.push(plain.subarray(1));
    this.partBytes += plain.length - 1;
    if (this.partBytes > sealedMessageMaxBytes(from)) throw new SealError("message too big");
    if (more === MORE) return null;
    const whole = new Uint8Array(this.partBytes);
    let at = 0;
    for (const part of this.parts) {
      whole.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.partBytes = 0;
    return new TextDecoder("utf-8", { fatal: true }).decode(whole);
  }
}

/** A direction's key is never used twice with the same counter, so the counter is the IV. */
function counterIv(n: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(n));
  return iv;
}

/** Checked with every frame: which way it travels and which number it is. */
function sealContext(from: SealSide, n: number): Uint8Array<ArrayBuffer> {
  return enc.encode(`${SEAL_LABEL}\n${SEAL_DIRECTION[from]}\n${n}`);
}
