import {
  LINK_FRAME_MAX_BYTES,
  LINK_PING,
  LINK_PING_MS,
  MAX_PHONES_PER_COMPUTER,
  MAX_SHARED_THREADS,
  PHONE_TICKET_SECONDS,
  parseLinkDown,
  signToken,
  type ComputerPlatform,
  type ComputerUpdate,
  type LinkUp,
  type LocalThreadSnapshot,
  type ThreadStatus,
} from "@lemonlime/protocol";
import type { LocalThreadMeta } from "./storage.ts";

/**
 * Phone access (docs/phone-access.md): while it's on, this app keeps one outbound link to
 * the control plane's phone bridge. When the user opens one of this computer's threads on
 * their phone, the bridge says so over the link; this app starts the thread's runner if
 * needed, opens the runner's WebSocket on loopback with a `phone` token it signs itself
 * (the thread secret never leaves this computer), and pipes frames both ways. The runner
 * checks that token like any other and gives a phone fewer powers than this app.
 */

export type PhoneLinkState = "off" | "connecting" | "live" | "unavailable" | "error";

export interface PhoneLinkApi {
  saveComputer(id: string, body: ComputerUpdate): Promise<{ bridgeAvailable: boolean }>;
  phoneLink(id: string): Promise<{ url: string; ticket: string; expiresAt: string }>;
}

export interface PhoneComputer {
  id: string;
  name: string;
  platform: ComputerPlatform;
}

export interface PhoneLinkOptions {
  api: PhoneLinkApi;
  computer: PhoneComputer;
  /** This computer's threads, as the dashboard may list them. */
  threads: () => LocalThreadSnapshot[];
  /** Start (or find) the runner of one of this computer's threads; null if it isn't one. */
  runner: (threadId: string) => Promise<{ port: number; secret: string } | null>;
  onState?: (state: PhoneLinkState, detail?: string) => void;
  WebSocketImpl?: typeof WebSocket;
  /** For tests. */
  now?: () => number;
}

interface Session {
  runner: WebSocket | null;
  /** Frames from the phone that arrived before the runner's socket opened. */
  early: string[];
  /** The token for the phone's hello, until the hello has gone to the runner. */
  token: string | null;
  ended: boolean;
}

/** How often to check in (the dashboard shows a computer as online for a couple of minutes after). */
const CHECK_IN_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

export class PhoneLink {
  private readonly opts: PhoneLinkOptions;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private readonly sessions = new Map<string, Session>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private state: PhoneLinkState = "off";

  constructor(opts: PhoneLinkOptions) {
    this.opts = opts;
  }

  get current(): PhoneLinkState {
    return this.state;
  }

  /** Turn phone access on: register this computer and keep the link open until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    void this.connect();
  }

  /**
   * Turn phone access off. Every phone session ends right here, before the control plane
   * hears about it; then the control plane forgets the shared threads and voids old tickets.
   */
  async stop(opts: { tell?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.teardown(1000, "phone access was turned off");
    this.setState("off");
    if (opts.tell !== false) await this.opts.api.saveComputer(this.opts.computer.id, { ...this.identity(), phoneAccess: false });
  }

  /** The thread list changed: tell the dashboard soon. */
  threadsChanged(): void {
    if (this.stopped || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.checkIn().catch(() => undefined);
    }, 2000);
  }

  /** Phone sessions open now. */
  get phoneSessions(): number {
    return [...this.sessions.values()].filter(s => !s.ended).length;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private identity() {
    const { name, platform } = this.opts.computer;
    return { name: name.slice(0, 100) || "My computer", platform };
  }

  private checkIn(): Promise<{ bridgeAvailable: boolean }> {
    return this.opts.api.saveComputer(this.opts.computer.id, {
      ...this.identity(),
      phoneAccess: true,
      threads: this.opts.threads().slice(0, MAX_SHARED_THREADS),
    });
  }

  private setState(state: PhoneLinkState, detail?: string): void {
    this.state = state;
    this.opts.onState?.(state, detail);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState("connecting");
    let link: { url: string; ticket: string; expiresAt: string };
    try {
      const saved = await this.checkIn();
      if (this.stopped) return;
      if (!saved.bridgeAvailable) return this.setState("unavailable");
      link = await this.opts.api.phoneLink(this.opts.computer.id);
    } catch (err) {
      this.setState("error", err instanceof Error ? err.message : String(err));
      return this.reconnectLater();
    }
    if (this.stopped) return;
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    const ws = new WS(link.url);
    this.ws = ws;
    ws.onopen = () => this.send({ type: "auth", ticket: link.ticket });
    ws.onmessage = ev => this.onLinkMessage(typeof ev.data === "string" ? ev.data : String(ev.data), link.expiresAt);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.teardown(1000, "");
      if (!this.stopped) {
        this.setState("connecting");
        this.reconnectLater();
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private reconnectLater(): void {
    if (this.stopped || this.retry) return;
    this.attempts += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempts, 6)) * (0.75 + Math.random() * 0.5);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }

  private onLinkMessage(raw: string, expiresAt: string): void {
    const msg = parseLinkDown(raw);
    if (!msg) return;
    switch (msg.type) {
      case "linked":
        this.attempts = 0;
        this.setState("live");
        this.keepAlive(expiresAt);
        break;
      case "open":
        void this.openSession(msg.session, msg.threadId, msg.userId, msg.exp);
        break;
      case "data":
        this.fromPhone(msg.session, msg.data);
        break;
      case "end":
        this.endSession(msg.session, null);
        break;
      case "pong":
        break;
    }
  }

  /** Ping the link, check in with the dashboard, and renew the link's ticket before it runs out. */
  private keepAlive(expiresAt: string): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const ping = setInterval(() => this.ws?.readyState === 1 && this.ws.send(LINK_PING), LINK_PING_MS);
    const checkIn = setInterval(() => void this.checkIn().catch(() => undefined), CHECK_IN_MS);
    const renewIn = Math.max(5_000, Date.parse(expiresAt) - (this.opts.now ?? Date.now)() - 2 * 60_000);
    const renew = setTimeout(() => {
      void this.opts.api
        .phoneLink(this.opts.computer.id)
        .then(next => {
          this.send({ type: "renew", ticket: next.ticket });
          this.keepAlive(next.expiresAt);
        })
        // The link closes when its ticket runs out, and connect() starts over.
        .catch(() => undefined);
    }, renewIn);
    this.timers.push(ping as unknown as ReturnType<typeof setTimeout>, checkIn as unknown as ReturnType<typeof setTimeout>, renew);
  }

  private async openSession(session: string, threadId: string, userId: string, exp: number): Promise<void> {
    if (this.phoneSessions >= MAX_PHONES_PER_COMPUTER) return this.send({ type: "end", session, code: 4429, reason: "too many connections" });
    const s: Session = { runner: null, early: [], token: null, ended: false };
    this.sessions.set(session, s);
    let runner: { port: number; secret: string } | null = null;
    try {
      runner = await this.opts.runner(threadId);
    } catch {
      runner = null;
    }
    if (s.ended) return;
    if (!runner) return this.endSession(session, { code: 4404, reason: "this thread isn't on this computer" });
    // The phone's hello comes first; it's answered with a token signed here, for this thread
    // and this user, no longer-lived than the phone's own ticket.
    const nowSec = Math.floor((this.opts.now ?? Date.now)() / 1000);
    const token = await signToken({ threadId, scope: "phone", sub: userId, exp: Math.min(exp, nowSec + PHONE_TICKET_SECONDS) }, runner.secret);
    if (s.ended) return;
    s.token = token;
    const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
    const ws = new WS(`ws://127.0.0.1:${runner.port}/ws`);
    s.runner = ws;
    ws.onopen = () => {
      for (const f of s.early.splice(0)) this.toRunner(session, s, f);
    };
    ws.onmessage = ev => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      // Wrapped, the frame has to fit the bridge's limit; one that wouldn't ends this phone's session.
      if (data.length * 1.2 + 200 > LINK_FRAME_MAX_BYTES) return this.endSession(session, { code: 1009, reason: "message too big" });
      this.send({ type: "data", session, data });
    };
    ws.onclose = ev => this.endSession(session, { code: ev.code === 4001 || ev.code === 4401 ? ev.code : 1000, reason: ev.reason?.slice(0, 120) ?? "" });
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private fromPhone(session: string, data: string): void {
    const s = this.sessions.get(session);
    if (!s || s.ended) return;
    if (s.runner?.readyState === 1) this.toRunner(session, s, data);
    else s.early.push(data);
  }

  private toRunner(session: string, s: Session, data: string): void {
    if (s.token !== null) {
      const hello = helloForRunner(data, s.token);
      s.token = null;
      if (!hello) return this.endSession(session, { code: 4401, reason: "send hello first" });
      s.runner?.send(hello);
      return;
    }
    s.runner?.send(data);
  }

  /** End a session: `tell` the bridge (with the runner's close code) unless it was the phone that left. */
  private endSession(session: string, tell: { code: number; reason: string } | null): void {
    const s = this.sessions.get(session);
    if (!s || s.ended) return;
    s.ended = true;
    this.sessions.delete(session);
    try {
      s.runner?.close(1000, "phone left");
    } catch {
      /* already closed */
    }
    if (tell) this.send({ type: "end", session, code: tell.code, reason: tell.reason });
  }

  private teardown(code: number, reason: string): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    for (const id of Array.from(this.sessions.keys())) this.endSession(id, null);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private send(msg: LinkUp): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}

/**
 * The phone's first frame, as the runner should get it: a hello with this app's token and
 * nothing else from the phone but where to resume. Null if it isn't a hello.
 */
export function helloForRunner(first: string, token: string): string | null {
  let parsed: { type?: unknown; resumeFrom?: unknown };
  try {
    parsed = JSON.parse(first) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed?.type !== "hello") return null;
  const resumeFrom = typeof parsed.resumeFrom === "number" && Number.isInteger(parsed.resumeFrom) && parsed.resumeFrom >= 0 ? parsed.resumeFrom : 0;
  return JSON.stringify({ type: "hello", token, resumeFrom });
}

/** What the dashboard may know about this computer's threads: never paths, never history. */
export function threadSnapshots(
  metas: readonly LocalThreadMeta[],
  opts: { archived?: Record<string, string>; status?: Record<string, ThreadStatus>; seq?: Record<string, number> } = {},
): LocalThreadSnapshot[] {
  return metas
    .filter(m => !opts.archived?.[m.id])
    .map(m => ({
      id: m.id,
      title: m.title.slice(0, 200),
      agent: { kind: m.agent.kind, ...(m.agent.model ? { model: m.agent.model.slice(0, 100) } : {}) },
      repoName: folderName(m.repoPath).slice(0, 200),
      branch: m.branch.slice(0, 300),
      status: opts.status?.[m.id] ?? m.status,
      latestSeq: Math.max(m.lastSeq, opts.seq?.[m.id] ?? 0),
      createdAt: new Date(m.createdAt).toISOString(),
      updatedAt: new Date(m.updatedAt).toISOString(),
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_SHARED_THREADS);
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || "repository"
  );
}

// ─── This computer ───────────────────────────────────────────────────────────

const KEY_COMPUTER_ID = "lemonlime:computer-id";

/** This computer's id for phone access: random, made once, kept here. */
export function computerId(): string {
  try {
    const kept = localStorage.getItem(KEY_COMPUTER_ID);
    if (kept && /^[a-z0-9-]{16,64}$/.test(kept)) return kept;
    const made = crypto.randomUUID();
    localStorage.setItem(KEY_COMPUTER_ID, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}

export function computerPlatform(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): ComputerPlatform {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "mac";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Linux|X11/i.test(userAgent)) return "linux";
  return "other";
}

/** What to call this computer until the user names it. */
export function defaultComputerName(platform: ComputerPlatform): string {
  return platform === "mac" ? "My Mac" : platform === "windows" ? "My PC" : "My computer";
}
