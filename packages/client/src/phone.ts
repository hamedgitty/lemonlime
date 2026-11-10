import {
  BRIDGE_CLOSE,
  BRIDGE_HELLO_MS,
  ComputerId,
  NOT_PAIRED_REASON,
  SealedChannel,
  isNotPairedClose,
  newSealHello,
  normalizePairingKey,
  parseSealHello,
  type Pairing,
} from "@lemonlime/protocol";

/**
 * The phone's side of phone access (docs/phone-access.md): where a browser keeps the
 * pairing keys of the computers it is paired with, and a WebSocket that seals everything
 * it sends to a computer and opens everything it gets back.
 */

// ─── Pairing keys in this browser ────────────────────────────────────────────

const PAIRING_PREFIX = "lemonlime:phone-pairing:";

/** The part of the browser's storage that pairing uses. */
export interface PairingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's own storage, or null where there is none (or it is switched off). */
function browserStorage(): PairingStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Keep a computer's pairing key in this browser. False when the browser wouldn't keep it. */
export function savePairing(pairing: Pairing, storage: PairingStorage | null = browserStorage()): boolean {
  const key = normalizePairingKey(pairing.key);
  if (!storage || !key || !ComputerId.safeParse(pairing.computerId).success) return false;
  try {
    storage.setItem(PAIRING_PREFIX + pairing.computerId, key);
    return storage.getItem(PAIRING_PREFIX + pairing.computerId) === key;
  } catch {
    return false;
  }
}

/** The pairing key this browser holds for a computer, if any. */
export function loadPairingKey(computerId: string, storage: PairingStorage | null = browserStorage()): string | null {
  try {
    const kept = storage?.getItem(PAIRING_PREFIX + computerId);
    return kept ? normalizePairingKey(kept) : null;
  } catch {
    return null;
  }
}

/** Unpair this browser from a computer. */
export function forgetPairing(computerId: string, storage: PairingStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(PAIRING_PREFIX + computerId);
  } catch {
    /* nothing was kept */
  }
}

// ─── A sealed connection to one thread on a computer ─────────────────────────

/**
 * Why a sealed connection was given up for good:
 * - `not-paired`: the computer doesn't accept this browser's pairing key;
 * - `unprotected`: something arrived that wasn't sealed for this session, so the other end
 *   isn't a computer that seals, or what it sent was changed on the way.
 */
export type SealRefusal = "not-paired" | "unprotected";

export interface SealedSocketOptions {
  /** The pairing key this browser holds for the computer. */
  key: string;
  computerId: string;
  threadId: string;
  /** Called once when the connection is given up for good; trying again won't help. */
  onRefused?: (why: SealRefusal) => void;
  /** The WebSocket underneath (the browser's own by default). */
  WebSocketImpl?: typeof WebSocket;
}

/** What `onclose` is given. */
interface Closed {
  code: number;
  reason: string;
}

const UNPROTECTED_REASON = "The connection to your computer wasn't protected";

/**
 * A WebSocket class for one thread on a paired computer, to give a RunnerClient as its
 * `WebSocketImpl`. To the code using it, it is the plain connection to the runner. On the
 * wire, the first frame still shows the bridge its ticket; then both ends say hello with a
 * nonce each, and every frame after that is sealed with keys only this browser and the
 * computer can derive. Anything that arrives unsealed, out of order or changed ends the
 * connection, and nothing from it is passed on.
 */
export function sealedWebSocket(opts: SealedSocketOptions): typeof WebSocket {
  const Inner = opts.WebSocketImpl ?? globalThis.WebSocket;

  class SealedSocket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: Closed) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    readonly url: string;

    private readonly inner: WebSocket;
    private readonly hello = newSealHello();
    private channel: SealedChannel | null = null;
    /** The first frame (the ticket for the bridge) has gone out. */
    private greeted = false;
    /** Messages to seal once the computer has said hello. */
    private waiting: string[] = [];
    private incoming: Promise<void> = Promise.resolve();
    private outgoing: Promise<void> = Promise.resolve();
    private helloTimer: ReturnType<typeof setTimeout> | null = null;
    private done = false;

    constructor(url: string | URL) {
      this.url = String(url);
      this.inner = new Inner(url);
      this.inner.onopen = () => {
        this.readyState = 1;
        this.onopen?.();
      };
      this.inner.onmessage = ev => this.receive(typeof ev.data === "string" ? ev.data : String(ev.data));
      this.inner.onclose = ev => this.finish(ev?.code ?? 1006, ev?.reason ?? "");
      this.inner.onerror = ev => this.onerror?.(ev);
    }

    send(data: string): void {
      if (this.done) return;
      if (!this.greeted) return this.greet(data);
      if (this.channel) this.sealAndSend(this.channel, data);
      else this.waiting.push(data);
    }

    close(code?: number, reason?: string): void {
      if (this.done) return;
      this.readyState = 2;
      this.inner.close(code, reason);
    }

    /**
     * The caller's first frame is its hello, with the bridge's ticket in it. The ticket goes
     * to the bridge in the clear, as the bridge needs; the rest of the hello waits to be sealed.
     */
    private greet(first: string): void {
      this.greeted = true;
      let hello: { type?: unknown; token?: unknown };
      try {
        hello = JSON.parse(first) as typeof hello;
      } catch {
        hello = {};
      }
      if (hello?.type !== "hello" || typeof hello.token !== "string") return this.giveUp("unprotected");
      const { token, ...rest } = hello;
      this.inner.send(JSON.stringify({ type: "hello", token }));
      this.inner.send(JSON.stringify(this.hello));
      this.waiting.push(JSON.stringify(rest));
      // A computer that seals answers at once. One that says nothing isn't waited for forever.
      this.helloTimer = setTimeout(() => {
        if (!this.channel && !this.done) this.inner.close(1000, "no answer");
      }, BRIDGE_HELLO_MS);
    }

    private receive(raw: string): void {
      this.incoming = this.incoming
        .then(async () => {
          if (this.done) return;
          if (!this.channel) return await this.start(raw);
          const message = await this.channel.open(raw);
          if (message !== null && !this.done) this.onmessage?.({ data: message });
        })
        .catch(() => this.giveUp("unprotected"));
    }

    /** The first frame back has to be the computer's hello; with it, both ends have the keys. */
    private async start(raw: string): Promise<void> {
      const theirs = parseSealHello(raw);
      if (!theirs || !this.greeted) return this.giveUp("unprotected");
      let channel: SealedChannel;
      try {
        channel = await SealedChannel.start({
          key: opts.key,
          computerId: opts.computerId,
          threadId: opts.threadId,
          phoneNonce: this.hello.nonce,
          computerNonce: theirs.nonce,
          side: "phone",
        });
      } catch {
        // What this browser kept isn't a pairing key.
        return this.giveUp("not-paired");
      }
      if (this.done) return;
      this.channel = channel;
      if (this.helloTimer) clearTimeout(this.helloTimer);
      for (const message of this.waiting.splice(0)) this.sealAndSend(channel, message);
    }

    private sealAndSend(channel: SealedChannel, message: string): void {
      this.outgoing = this.outgoing
        .then(async () => {
          if (this.done) return;
          const frames = await channel.seal(message);
          if (this.done) return;
          for (const frame of frames) this.inner.send(frame);
        })
        // The only message that can't be sealed is one too big for the computer to take.
        .catch(() => {
          if (!this.done) this.inner.close(1000, "message too big");
        });
    }

    /** End the connection for good and say why. */
    private giveUp(why: SealRefusal): void {
      if (this.done) return;
      try {
        this.inner.close(1000, "");
      } catch {
        /* already closed */
      }
      opts.onRefused?.(why);
      this.finish(BRIDGE_CLOSE.notPaired, why === "not-paired" ? NOT_PAIRED_REASON : UNPROTECTED_REASON, true);
    }

    private finish(code: number, reason: string, told = false): void {
      if (this.done) return;
      this.done = true;
      this.readyState = 3;
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.waiting = [];
      // A bridge that doesn't know the code still passes the reason on.
      const refused = isNotPairedClose(code, reason);
      if (refused && !told) opts.onRefused?.("not-paired");
      this.onclose?.({ code: refused ? BRIDGE_CLOSE.notPaired : code, reason });
    }
  }

  return SealedSocket as unknown as typeof WebSocket;
}
