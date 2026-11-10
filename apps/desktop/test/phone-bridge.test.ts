import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CLOSE,
  BRIDGE_HELLO_MS,
  LocalThreadSnapshot,
  NOT_PAIRED_REASON,
  PHONE_FRAME_MAX_BYTES,
  SealedChannel,
  newPairingKey,
  newSealHello,
  parseSealHello,
  verifyToken,
  type ComputerUpdate,
  type LinkUp,
} from "@lemonlime/protocol";
import { computerPlatform, helloForRunner, PhoneLink, threadSnapshots } from "../src/lib/phoneBridge.ts";
import type { LocalThreadMeta } from "../src/lib/storage.ts";

/** A stand-in for a WebSocket (the link to the bridge, or the one to a runner), driven by hand. */
class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

const meta = (id: string, over: Partial<LocalThreadMeta> = {}): LocalThreadMeta => ({
  id,
  title: "Fix the build",
  agent: { kind: "codex", model: "gpt-x", command: ["secret-wrapper", "--token", "abc"] },
  repoPath: "/Users/someone/code/my-app",
  baseBranch: "main",
  branch: `agent/${id}`,
  status: "idle",
  lastSeq: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...over,
});

describe("phone access on the desktop", () => {
  it("hands the runner a hello with this app's token and only where to resume", () => {
    const out = JSON.parse(helloForRunner(JSON.stringify({ type: "hello", resumeFrom: 12, computer: true, token: "phone-sent-this" }), "minted")!);
    expect(out).toEqual({ type: "hello", token: "minted", resumeFrom: 12 });
    expect(JSON.parse(helloForRunner('{"type":"hello","resumeFrom":-3}', "t")!).resumeFrom).toBe(0);
    expect(helloForRunner('{"type":"send_message","text":"x"}', "t")).toBeNull();
    expect(helloForRunner("not json", "t")).toBeNull();
  });

  it("shares threads without paths or commands, leaving archived ones out", () => {
    const list = threadSnapshots([meta("thread-aaaaaa"), meta("thread-bbbbbb")], {
      archived: { "thread-bbbbbb": "2026-01-03T00:00:00.000Z" },
      status: { "thread-aaaaaa": "running" },
    });
    expect(list).toHaveLength(1);
    expect(LocalThreadSnapshot.parse(list[0])).toEqual(list[0]);
    expect(list[0]).toMatchObject({ repoName: "my-app", status: "running", agent: { kind: "codex", model: "gpt-x" } });
    const text = JSON.stringify(list);
    expect(text).not.toContain("/Users/someone");
    expect(text).not.toContain("secret-wrapper");
  });

  it("tells computers apart", () => {
    expect(computerPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("mac");
    expect(computerPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(computerPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});

describe("the link to the dashboard", () => {
  beforeEach(() => {
    FakeSocket.made = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

  /** A link that is up, with a ticket due for renewal in ten seconds. */
  async function liveLink(nextTicket: () => Promise<{ url: string; ticket: string; expiresAt: string }>) {
    const saved: ComputerUpdate[] = [];
    let asked = 0;
    const link = new PhoneLink({
      api: {
        saveComputer: async (_id, body) => {
          saved.push(body);
          return { bridgeAvailable: true };
        },
        phoneLink: () => (asked++ === 0 ? Promise.resolve({ url: "wss://bridge.test/link", ticket: "first", expiresAt: inSeconds(130) }) : nextTicket()),
      },
      computer: { id: "c1", name: "Desk", platform: "mac" },
      threads: () => [],
      runner: async () => null,
      pairingKey: () => null,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    link.start();
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.made[0]!;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "linked" }) });
    return { link, socket, saved };
  }

  it("says that it only answers paired phones, every time it checks in", async () => {
    const { link, saved } = await liveLink(async () => ({ url: "wss://bridge.test/link", ticket: "second", expiresAt: inSeconds(600) }));
    await link.stop();
    expect(saved.length).toBeGreaterThanOrEqual(2);
    expect(saved.every(update => update.sealed === true)).toBe(true);
  });

  it("signs in with its ticket and renews it before it runs out", async () => {
    const { link, socket } = await liveLink(async () => ({ url: "wss://bridge.test/link", ticket: "second", expiresAt: inSeconds(600) }));
    expect(link.current).toBe("live");
    expect(socket.sent.map(s => JSON.parse(s))).toEqual([{ type: "auth", ticket: "first" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent.map(s => JSON.parse(s))).toContainEqual({ type: "renew", ticket: "second" });
    await link.stop({ tell: false });
  });

  it("starts nothing again when a new ticket arrives after phone access was turned off", async () => {
    let arrive!: (t: { url: string; ticket: string; expiresAt: string }) => void;
    const { link, socket, saved } = await liveLink(() => new Promise(r => (arrive = r)));
    await vi.advanceTimersByTimeAsync(10_000);
    await link.stop();
    expect(saved.at(-1)?.phoneAccess).toBe(false);
    const told = saved.length;
    arrive({ url: "wss://bridge.test/link", ticket: "second", expiresAt: inSeconds(600) });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // No check-in says phone access is on again, and the dead link gets no new ticket.
    expect(saved.length).toBe(told);
    expect(socket.sent.some(s => s.includes("renew"))).toBe(false);
    expect(link.current).toBe("off");
  });
});

describe("a phone's session", () => {
  const COMPUTER = "computer-0123456789abcdef";
  const THREAD = "thread-aaaaaa";
  const SECRET = "the-thread-secret-that-stays-here";
  const SESSION = "session-1";
  // Kept from before any test swaps the clock for a fake one.
  const realTimeout = setTimeout;

  beforeEach(() => {
    FakeSocket.made = [];
  });
  afterEach(() => vi.useRealTimers());

  /** Wait for something that takes a few turns of real work (deriving keys, sealing). */
  async function until(check: () => boolean): Promise<void> {
    const start = performance.now();
    while (!check()) {
      if (performance.now() - start > 3000) throw new Error("timed out waiting");
      await new Promise(resolve => realTimeout(resolve, 2));
    }
  }

  /** This computer with phone access on and its link up. */
  async function computer(opts: { key?: string | null } = {}) {
    const pairing = { key: opts.key === undefined ? newPairingKey() : opts.key };
    const started: string[] = [];
    const link = new PhoneLink({
      api: {
        saveComputer: async () => ({ bridgeAvailable: true }),
        phoneLink: async () => ({ url: "wss://bridge.test/link", ticket: "ticket", expiresAt: new Date(Date.now() + 900_000).toISOString() }),
      },
      computer: { id: COMPUTER, name: "Desk", platform: "mac" },
      threads: () => [],
      runner: async threadId => {
        started.push(threadId);
        return { port: 4567, secret: SECRET };
      },
      pairingKey: () => pairing.key,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    link.start();
    await until(() => FakeSocket.made.length === 1);
    const bridge = FakeSocket.made[0]!;
    bridge.onopen?.();
    bridge.onmessage?.({ data: JSON.stringify({ type: "linked" }) });
    /** What the bridge sends this computer about one phone. */
    const fromBridge = (msg: Record<string, unknown>) => bridge.onmessage?.({ data: JSON.stringify({ session: SESSION, ...msg }) });
    /** What this computer has sent back for that phone. */
    const toPhone = () =>
      bridge.sent.map(raw => JSON.parse(raw) as LinkUp).filter((m): m is Extract<LinkUp, { type: "data" | "end" }> => m.type === "data" || m.type === "end");
    const frames = () => toPhone().flatMap(m => (m.type === "data" ? [m.data] : []));
    const ended = () => toPhone().find(m => m.type === "end") ?? null;
    /** The bridge says a phone connected, and passes on the hello it took the phone's ticket from. */
    const phoneConnects = () => {
      fromBridge({ type: "open", threadId: THREAD, userId: "user-1", exp: Math.floor(Date.now() / 1000) + 600 });
      fromBridge({ type: "data", data: JSON.stringify({ type: "hello", resumeFrom: 0 }) });
    };
    /** A phone says hello, reads this computer's hello, and has the session's keys if `key` is the right one. */
    const phoneSaysHello = async (key: string) => {
      const mine = newSealHello();
      fromBridge({ type: "data", data: JSON.stringify(mine) });
      await until(() => frames().length === 1);
      const theirs = parseSealHello(frames()[0]!)!;
      return SealedChannel.start({ key, computerId: COMPUTER, threadId: THREAD, phoneNonce: mine.nonce, computerNonce: theirs.nonce, side: "phone" });
    };
    /** Seal a message as the phone and send it through the bridge. */
    const phoneSends = async (channel: SealedChannel, message: string) => {
      const sealed = await channel.seal(message);
      for (const data of sealed) fromBridge({ type: "data", data });
      return sealed;
    };
    /** A paired phone all the way in: hello, first sealed message, and the runner's socket open. */
    const pairedPhone = async () => {
      phoneConnects();
      const channel = await phoneSaysHello(pairing.key!);
      await phoneSends(channel, JSON.stringify({ type: "hello", resumeFrom: 7 }));
      await until(() => FakeSocket.made.length === 2);
      const runner = FakeSocket.made[1]!;
      runner.onopen?.();
      return { channel, runner };
    };
    return { link, bridge, pairing, started, fromBridge, toPhone, frames, ended, phoneConnects, phoneSaysHello, phoneSends, pairedPhone };
  }

  const notPaired = { type: "end", session: SESSION, code: BRIDGE_CLOSE.notPaired, reason: NOT_PAIRED_REASON };

  it("starts nothing for a phone until a frame sealed with the pairing key has opened", async () => {
    const c = await computer();
    c.phoneConnects();
    const channel = await c.phoneSaysHello(c.pairing.key!);
    // So far the phone has only been told a nonce: no runner, no connection to one.
    expect(c.frames()).toHaveLength(1);
    expect(parseSealHello(c.frames()[0]!)).not.toBeNull();
    expect(c.started).toEqual([]);
    expect(FakeSocket.made).toHaveLength(1);

    await c.phoneSends(channel, JSON.stringify({ type: "hello", resumeFrom: 7, token: "from-the-phone" }));
    await until(() => FakeSocket.made.length === 2);
    expect(c.started).toEqual([THREAD]);
    const runner = FakeSocket.made[1]!;
    expect(runner.url).toBe("ws://127.0.0.1:4567/ws");
    runner.onopen?.();
    // The runner gets a hello with a token signed here, for this thread, as a phone.
    const hello = JSON.parse(runner.sent[0]!) as { type: string; token: string; resumeFrom: number };
    expect(hello).toMatchObject({ type: "hello", resumeFrom: 7 });
    const checked = await verifyToken(hello.token, SECRET);
    expect(checked.ok && checked.claims).toMatchObject({ threadId: THREAD, scope: "phone", sub: "user-1" });
    await c.link.stop({ tell: false });
  });

  it("carries messages both ways, sealed on the way through the bridge", async () => {
    const c = await computer();
    const { channel, runner } = await c.pairedPhone();
    const sealed = await c.phoneSends(channel, JSON.stringify({ type: "send_message", text: "ship the lemon build" }));
    expect(sealed.join("")).not.toContain("lemon build");
    await until(() => runner.sent.length === 2);
    expect(JSON.parse(runner.sent[1]!)).toEqual({ type: "send_message", text: "ship the lemon build" });

    const answer = JSON.stringify({ type: "event", event: { seq: 8, text: "the lime tests pass" } });
    runner.onmessage?.({ data: answer });
    await until(() => c.frames().length === 2);
    expect(c.frames()[1]).not.toContain("lime tests");
    expect(await channel.open(c.frames()[1]!)).toBe(answer);
    expect(c.ended()).toBeNull();
    await c.link.stop({ tell: false });
  });

  it("sends a long message from the runner as several frames the phone puts back together", async () => {
    const c = await computer();
    const { channel, runner } = await c.pairedPhone();
    const long = JSON.stringify({ type: "event", text: "z".repeat(400 * 1024) });
    runner.onmessage?.({ data: long });
    await until(() => c.frames().length >= 5);
    const parts = c.frames().slice(1);
    expect(parts.every(frame => frame.length <= PHONE_FRAME_MAX_BYTES)).toBe(true);
    let whole: string | null = null;
    for (const frame of parts) whole = await channel.open(frame);
    expect(whole).toBe(long);
    await c.link.stop({ tell: false });
  });

  it("turns away a phone that doesn't seal, without starting anything", async () => {
    const c = await computer();
    c.phoneConnects();
    c.fromBridge({ type: "data", data: JSON.stringify({ type: "send_message", text: "let me in" }) });
    await until(() => c.ended() !== null);
    expect(c.toPhone()).toEqual([notPaired]);
    expect(c.started).toEqual([]);
    expect(FakeSocket.made).toHaveLength(1);
    expect(c.link.phoneSessions).toBe(0);
    await c.link.stop({ tell: false });
  });

  it("turns away a phone paired with another key", async () => {
    const c = await computer();
    c.phoneConnects();
    const channel = await c.phoneSaysHello(newPairingKey());
    await c.phoneSends(channel, JSON.stringify({ type: "hello", resumeFrom: 0 }));
    await until(() => c.ended() !== null);
    expect(c.ended()).toEqual(notPaired);
    expect(c.started).toEqual([]);
    expect(FakeSocket.made).toHaveLength(1);
    await c.link.stop({ tell: false });
  });

  it("turns every phone away while this computer has no pairing key", async () => {
    const c = await computer({ key: null });
    c.phoneConnects();
    expect(c.toPhone()).toEqual([notPaired]);
    expect(c.started).toEqual([]);
    await c.link.stop({ tell: false });
  });

  it("ends the session when a sealed frame arrives a second time", async () => {
    const c = await computer();
    const { channel, runner } = await c.pairedPhone();
    const sealed = await c.phoneSends(channel, JSON.stringify({ type: "send_message", text: "once" }));
    c.fromBridge({ type: "data", data: sealed[0] });
    await until(() => c.ended() !== null);
    expect(c.ended()).toEqual(notPaired);
    // The message went to the runner once, and the runner's socket was closed.
    expect(runner.sent.filter(raw => raw.includes("once"))).toHaveLength(1);
    expect(runner.readyState).toBe(3);
    await c.link.stop({ tell: false });
  });

  it("ends the session when a frame arrives unsealed after sealing began", async () => {
    const c = await computer();
    const { runner } = await c.pairedPhone();
    c.fromBridge({ type: "data", data: JSON.stringify({ type: "send_message", text: "slipped in by the bridge" }) });
    await until(() => c.ended() !== null);
    expect(c.ended()).toEqual(notPaired);
    expect(runner.sent.some(raw => raw.includes("slipped in"))).toBe(false);
    await c.link.stop({ tell: false });
  });

  it("cuts paired phones off when the pairing key is replaced", async () => {
    const c = await computer();
    const { runner } = await c.pairedPhone();
    c.pairing.key = newPairingKey();
    c.link.unpairPhones();
    expect(c.ended()).toEqual(notPaired);
    expect(runner.readyState).toBe(3);
    expect(c.link.phoneSessions).toBe(0);
    await c.link.stop({ tell: false });
  });

  it("passes on what the runner said last before it ends the session", async () => {
    const c = await computer();
    const { channel, runner } = await c.pairedPhone();
    const last = JSON.stringify({ type: "error", message: "this token has run out" });
    runner.onmessage?.({ data: last });
    runner.onclose?.({ code: 4001, reason: "token expired" });
    await until(() => c.ended() !== null);
    const sent = c.toPhone();
    expect(sent.map(m => m.type)).toEqual(["data", "data", "end"]);
    expect(await channel.open(c.frames()[1]!)).toBe(last);
    expect(sent[2]).toEqual({ type: "end", session: SESSION, code: 4001, reason: "token expired" });
    await c.link.stop({ tell: false });
  });

  it("doesn't wait long for a phone that never says it seals", async () => {
    vi.useFakeTimers();
    const c = await computer();
    c.phoneConnects();
    vi.advanceTimersByTime(BRIDGE_HELLO_MS - 1);
    expect(c.ended()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(c.ended()).toEqual(notPaired);
    expect(c.started).toEqual([]);
    await c.link.stop({ tell: false });
  });

  it("lets go of a phone that said hello and then nothing, without telling it to pair again", async () => {
    vi.useFakeTimers();
    const c = await computer();
    c.phoneConnects();
    await c.phoneSaysHello(c.pairing.key!);
    vi.advanceTimersByTime(BRIDGE_HELLO_MS);
    expect(c.ended()).toEqual({ type: "end", session: SESSION, code: BRIDGE_CLOSE.idle, reason: "idle" });
    expect(c.started).toEqual([]);
    await c.link.stop({ tell: false });
  });
});
