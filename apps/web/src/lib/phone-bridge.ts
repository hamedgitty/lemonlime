import {
  BRIDGE_CLOSE,
  BRIDGE_HELLO_MS,
  LINK_FRAME_MAX_BYTES,
  LINK_IDLE_MS,
  MAX_PHONES_PER_COMPUTER,
  MAX_PHONES_PER_THREAD,
  PHONE_FRAME_MAX_BYTES,
  PHONE_IDLE_MS,
  frameBytes,
  parseLinkUp,
  verifyBridgeTicket,
  type LinkDown,
} from "@lemonlime/protocol";
import type { AppContext } from "./context.ts";

/**
 * The phone bridge (docs/phone-access.md): pipes a phone's WebSocket for one local thread
 * to the desktop app's link from that computer, and back. It never reads the database:
 * everyone who connects shows a ticket the control plane signed after checking them.
 *
 * `BridgeHub` keeps no state of its own besides what it stores on each socket, so the same
 * code runs in a Cloudflare Durable Object (whose sockets hibernate and come back with
 * only that stored "peer") and in the Node server's in-process hub.
 */

export type Peer =
  | { role: "pending-link"; computerId: string; since: number; checking?: true }
  | { role: "pending-phone"; computerId: string; threadId: string; since: number; checking?: true }
  | { role: "link"; computerId: string; userId: string; epoch: number; exp: number; lastAt: number }
  | { role: "phone"; computerId: string; threadId: string; userId: string; epoch: number; exp: number; lastAt: number; session: string }
  /** Closed by the hub; ignored until the platform forgets it. */
  | { role: "closed" };

export interface BridgeSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** What the hub needs from the platform. */
export interface BridgeHost<S extends BridgeSocket> {
  sockets(): Iterable<S>;
  peer(s: S): Peer | null;
  setPeer(s: S, peer: Peer): void;
  /** When the socket last sent a ping the platform answered for us (Workers' auto-response), in ms. */
  lastPing?(s: S): number;
  now(): number;
  newId(): string;
}

/** Paths the bridge answers; ids are checked again against the tickets. */
export function bridgePath(pathname: string): { kind: "link"; computerId: string } | { kind: "phone"; computerId: string; threadId: string } | null {
  const link = /^\/api\/phone\/link\/([a-z0-9-]{16,64})$/.exec(pathname);
  if (link) return { kind: "link", computerId: link[1]! };
  const phone = /^\/api\/phone\/ws\/([a-z0-9-]{16,64})\/([a-z0-9][a-z0-9-]{5,63})$/.exec(pathname);
  if (phone) return { kind: "phone", computerId: phone[1]!, threadId: phone[2]! };
  return null;
}

/** The peer a new socket on `path` starts as. */
export function pendingPeer(path: NonNullable<ReturnType<typeof bridgePath>>, now: number): Peer {
  return path.kind === "link"
    ? { role: "pending-link", computerId: path.computerId, since: now }
    : { role: "pending-phone", computerId: path.computerId, threadId: path.threadId, since: now };
}

/** Close codes a desktop app may pass on to a phone: the runner's, and its own for a phone that isn't paired with it. */
const PASS_ON = new Set<number>([
  1000,
  1011,
  BRIDGE_CLOSE.tokenExpired,
  BRIDGE_CLOSE.unauthorized,
  BRIDGE_CLOSE.offline,
  BRIDGE_CLOSE.idle,
  BRIDGE_CLOSE.notPaired,
]);

export class BridgeHub<S extends BridgeSocket> {
  private readonly host: BridgeHost<S>;
  private readonly key: () => Promise<string>;

  constructor(host: BridgeHost<S>, key: () => Promise<string>) {
    this.host = host;
    this.key = key;
  }

  /** Each socket's frames are handled one at a time, in order (some steps wait on crypto). */
  private readonly queues = new WeakMap<S, Promise<void>>();

  /** A frame from any socket. */
  message(s: S, data: string): Promise<void> {
    const next = (this.queues.get(s) ?? Promise.resolve())
      .then(() => this.handle(s, data))
      .catch(err => console.error("[lemonlime] phone bridge: a message failed:", err));
    this.queues.set(s, next);
    return next;
  }

  private async handle(s: S, data: string): Promise<void> {
    const p = this.host.peer(s);
    if (!p || p.role === "closed") return;
    const max = p.role === "link" || p.role === "pending-link" ? LINK_FRAME_MAX_BYTES : PHONE_FRAME_MAX_BYTES;
    if (frameBytes(data) > max) return this.close(s, BRIDGE_CLOSE.tooBig, "message too big");
    const now = this.host.now();
    switch (p.role) {
      case "pending-link":
        return this.authLink(s, p, data);
      case "pending-phone":
        return this.authPhone(s, p, data);
      case "phone": {
        const link = this.linkOf(p.computerId);
        if (!link) return this.close(s, BRIDGE_CLOSE.offline, "your computer is offline");
        this.host.setPeer(s, { ...p, lastAt: now });
        return this.sendTo(link.socket, { type: "data", session: p.session, data });
      }
      case "link":
        return this.fromLink(s, p, data, now);
    }
  }

  /** The platform saw the socket close. */
  closed(s: S): void {
    const p = this.host.peer(s);
    if (!p || p.role === "closed") return;
    this.host.setPeer(s, { role: "closed" });
    this.cleanUp(p);
  }

  /** Turn phone access off for a computer: its link and every phone on it close now. */
  kill(computerId: string): number {
    let n = 0;
    // Phones first, so they hear why; then the link.
    for (const role of ["phone", "pending-phone", "link", "pending-link"] as const) {
      for (const s of Array.from(this.host.sockets())) {
        const p = this.host.peer(s);
        if (p && p.role !== "closed" && p.role === role && p.computerId === computerId) {
          this.close(s, BRIDGE_CLOSE.turnedOff, "phone access was turned off");
          n++;
        }
      }
    }
    return n;
  }

  /** True while the computer's desktop app is linked. */
  linked(computerId: string): boolean {
    return this.linkOf(computerId) !== null;
  }

  /** Phones connected now, by thread (for tests and status). */
  phones(computerId: string): number {
    return this.phonesOf(computerId).length;
  }

  /**
   * Close what has run out: tickets at their expiry (4001, like the runner), silent links and
   * phones, and sockets that never said who they are. Returns when to look again (ms), or null.
   */
  sweep(): number | null {
    const now = this.host.now();
    const deadlines: number[] = [];
    for (const s of Array.from(this.host.sockets())) {
      const p = this.host.peer(s);
      if (!p || p.role === "closed") continue;
      if (p.role === "pending-link" || p.role === "pending-phone") {
        if (now - p.since >= BRIDGE_HELLO_MS) this.close(s, BRIDGE_CLOSE.unauthorized, "no hello");
        else deadlines.push(p.since + BRIDGE_HELLO_MS);
        continue;
      }
      if (p.exp * 1000 <= now) {
        this.close(s, BRIDGE_CLOSE.tokenExpired, "token expired");
        continue;
      }
      const heard = p.role === "link" ? Math.max(p.lastAt, this.host.lastPing?.(s) ?? 0) : p.lastAt;
      const idle = p.role === "link" ? LINK_IDLE_MS : PHONE_IDLE_MS;
      if (now - heard >= idle) {
        this.close(s, BRIDGE_CLOSE.idle, "idle");
        continue;
      }
      deadlines.push(Math.min(p.exp * 1000, heard + idle));
    }
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async authLink(s: S, p: Extract<Peer, { role: "pending-link" }>, data: string): Promise<void> {
    if (p.checking) return this.close(s, BRIDGE_CLOSE.unauthorized, "wait for the link to open");
    const msg = parseLinkUp(data);
    if (msg?.type !== "auth") return this.close(s, BRIDGE_CLOSE.unauthorized, "send auth first");
    this.host.setPeer(s, { ...p, checking: true });
    const ticket = await verifyBridgeTicket(msg.ticket, await this.key(), Math.floor(this.host.now() / 1000));
    if (this.host.peer(s)?.role !== "pending-link") return; // closed meanwhile
    if (ticket?.kind !== "link" || ticket.computerId !== p.computerId) return this.close(s, BRIDGE_CLOSE.unauthorized, "unauthorized");
    // One link per computer: a newer one (the app restarted, or the network changed) takes over.
    for (const other of Array.from(this.host.sockets())) {
      const o = this.host.peer(other);
      if (other !== s && o?.role === "link" && o.computerId === p.computerId) this.close(other, BRIDGE_CLOSE.replaced, "replaced by a newer link");
    }
    this.host.setPeer(s, { role: "link", computerId: p.computerId, userId: ticket.userId, epoch: ticket.epoch, exp: ticket.exp, lastAt: this.host.now() });
    this.sendTo(s, { type: "linked" });
  }

  private async authPhone(s: S, p: Extract<Peer, { role: "pending-phone" }>, data: string): Promise<void> {
    if (p.checking) return this.close(s, BRIDGE_CLOSE.unauthorized, "send hello first");
    type Hello = { type?: unknown; token?: unknown; resumeFrom?: unknown };
    let hello: Hello | null;
    try {
      hello = JSON.parse(data) as Hello | null;
    } catch {
      hello = null;
    }
    if (hello?.type !== "hello" || typeof hello.token !== "string") return this.close(s, BRIDGE_CLOSE.unauthorized, "send hello first");
    this.host.setPeer(s, { ...p, checking: true });
    const ticket = await verifyBridgeTicket(hello.token, await this.key(), Math.floor(this.host.now() / 1000));
    if (this.host.peer(s)?.role !== "pending-phone") return;
    if (ticket?.kind !== "phone" || ticket.computerId !== p.computerId || ticket.threadId !== p.threadId) {
      return this.close(s, BRIDGE_CLOSE.unauthorized, "unauthorized");
    }
    const link = this.linkOf(p.computerId);
    if (!link) return this.close(s, BRIDGE_CLOSE.offline, "your computer is offline");
    // Handed out before phone access was last turned off, or for someone else's computer.
    if (link.peer.epoch !== ticket.epoch || link.peer.userId !== ticket.userId) return this.close(s, BRIDGE_CLOSE.unauthorized, "unauthorized");
    const phones = this.phonesOf(p.computerId);
    if (phones.length >= MAX_PHONES_PER_COMPUTER || phones.filter(x => x.threadId === p.threadId).length >= MAX_PHONES_PER_THREAD) {
      return this.close(s, BRIDGE_CLOSE.busy, "too many connections");
    }
    const session = this.host.newId();
    const now = this.host.now();
    this.host.setPeer(s, {
      role: "phone",
      computerId: p.computerId,
      threadId: p.threadId,
      userId: ticket.userId,
      epoch: ticket.epoch,
      exp: ticket.exp,
      lastAt: now,
      session,
    });
    this.sendTo(link.socket, { type: "open", session, threadId: p.threadId, userId: ticket.userId, exp: ticket.exp });
    // The hello goes on without the ticket; the desktop app adds its own token for the runner.
    const resumeFrom = typeof hello.resumeFrom === "number" && Number.isInteger(hello.resumeFrom) && hello.resumeFrom >= 0 ? hello.resumeFrom : 0;
    this.sendTo(link.socket, { type: "data", session, data: JSON.stringify({ type: "hello", resumeFrom }) });
  }

  private async fromLink(s: S, p: Extract<Peer, { role: "link" }>, data: string, now: number): Promise<void> {
    const msg = parseLinkUp(data);
    if (!msg) return;
    this.host.setPeer(s, { ...p, lastAt: now });
    switch (msg.type) {
      case "ping":
        return this.sendTo(s, { type: "pong" });
      case "data": {
        const phone = this.phoneOf(p.computerId, msg.session);
        if (!phone) return;
        if (frameBytes(msg.data) > LINK_FRAME_MAX_BYTES) return this.close(phone.socket, BRIDGE_CLOSE.tooBig, "message too big");
        this.host.setPeer(phone.socket, { ...phone.peer, lastAt: now });
        try {
          phone.socket.send(msg.data);
        } catch {
          this.closed(phone.socket);
        }
        return;
      }
      case "end": {
        const phone = this.phoneOf(p.computerId, msg.session);
        if (!phone) return;
        this.host.setPeer(phone.socket, { role: "closed" });
        this.safeClose(phone.socket, msg.code !== undefined && PASS_ON.has(msg.code) ? msg.code : 1000, msg.reason ?? "");
        return;
      }
      case "renew": {
        const ticket = await verifyBridgeTicket(msg.ticket, await this.key(), Math.floor(this.host.now() / 1000));
        const current = this.host.peer(s);
        if (current?.role !== "link") return;
        if (ticket?.kind !== "link" || ticket.computerId !== p.computerId || ticket.userId !== p.userId || ticket.epoch !== p.epoch) {
          return this.close(s, BRIDGE_CLOSE.unauthorized, "unauthorized");
        }
        this.host.setPeer(s, { ...current, exp: Math.max(current.exp, ticket.exp) });
        return;
      }
      case "auth":
        return;
    }
  }

  /** Close a socket the hub decided to close, and tidy up after it. */
  private close(s: S, code: number, reason: string): void {
    const p = this.host.peer(s);
    this.host.setPeer(s, { role: "closed" });
    this.safeClose(s, code, reason);
    if (p && p.role !== "closed") this.cleanUp(p);
  }

  private cleanUp(p: Exclude<Peer, { role: "closed" }>): void {
    if (p.role === "link") {
      // The computer went away (or was replaced): its phones can't reach it any more.
      for (const phone of this.phonesOf(p.computerId)) this.close(phone.socket, BRIDGE_CLOSE.offline, "your computer is offline");
    } else if (p.role === "phone") {
      const link = this.linkOf(p.computerId);
      if (link) this.sendTo(link.socket, { type: "end", session: p.session });
    }
  }

  private safeClose(s: S, code: number, reason: string): void {
    try {
      s.close(code, reason.slice(0, 120));
    } catch {
      /* already closed */
    }
  }

  private sendTo(s: S, msg: LinkDown): void {
    try {
      s.send(JSON.stringify(msg));
    } catch {
      this.closed(s);
    }
  }

  private linkOf(computerId: string): { socket: S; peer: Extract<Peer, { role: "link" }> } | null {
    for (const s of this.host.sockets()) {
      const p = this.host.peer(s);
      if (p?.role === "link" && p.computerId === computerId) return { socket: s, peer: p };
    }
    return null;
  }

  private phonesOf(computerId: string): Array<{ socket: S; peer: Extract<Peer, { role: "phone" }> } & { threadId: string }> {
    const out: Array<{ socket: S; peer: Extract<Peer, { role: "phone" }> } & { threadId: string }> = [];
    for (const s of this.host.sockets()) {
      const p = this.host.peer(s);
      if (p?.role === "phone" && p.computerId === computerId) out.push({ socket: s, peer: p, threadId: p.threadId });
    }
    return out;
  }

  private phoneOf(computerId: string, session: string): { socket: S; peer: Extract<Peer, { role: "phone" }> } | null {
    return this.phonesOf(computerId).find(x => x.peer.session === session) ?? null;
  }
}

// ─── Reaching the bridge from route handlers ────────────────────────────────

/** What the control plane's routes ask of the bridge. */
export interface BridgeControl {
  /** Is the computer's desktop app linked right now? */
  linked(computerId: string): Promise<boolean>;
  /** Cut the computer's link and every phone on it. */
  kill(computerId: string): Promise<void>;
}

const NODE_BRIDGE = Symbol.for("lemonlime.phone-bridge");

/** The Node server (apps/web/server.ts) registers its in-process hub here. */
export function registerNodeBridge(control: BridgeControl | null): void {
  (globalThis as Record<symbol, unknown>)[NODE_BRIDGE] = control;
}

/** The Durable Object namespace bound as PHONE_BRIDGE (see wrangler.jsonc). */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

function isNamespace(value: unknown): value is DurableObjectNamespaceLike {
  return typeof value === "object" && value !== null && typeof (value as DurableObjectNamespaceLike).idFromName === "function";
}

/**
 * The bridge for this deployment, or null when it isn't set up: on Workers, no PHONE_BRIDGE
 * Durable Object binding; on Node, the app was started without its own server (`next start`
 * or `next dev` can't take WebSockets). Phone access then says it's unavailable.
 */
export function bridgeControl(ctx: AppContext): BridgeControl | null {
  if (ctx.runtime === "workers") {
    const ns = ctx.env.PHONE_BRIDGE;
    if (!isNamespace(ns)) return null;
    const call = (path: string, computerId: string, method: "GET" | "POST") =>
      ns.get(ns.idFromName(computerId)).fetch(`https://phone-bridge${path}?computer=${encodeURIComponent(computerId)}`, { method });
    return {
      async linked(computerId) {
        const res = await call("/internal/status", computerId, "GET").catch(() => null);
        const body = (await res?.json().catch(() => null)) as { linked?: unknown } | null;
        return body?.linked === true;
      },
      async kill(computerId) {
        await call("/internal/kill", computerId, "POST");
      },
    };
  }
  return ((globalThis as Record<symbol, unknown>)[NODE_BRIDGE] as BridgeControl | null | undefined) ?? null;
}

/** ws:// or wss:// for this control plane's public address. */
export function bridgeBaseUrl(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, "").replace(/^http(s?):\/\//, "ws$1://");
}
