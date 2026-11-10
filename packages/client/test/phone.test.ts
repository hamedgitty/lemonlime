import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CLOSE,
  BRIDGE_HELLO_MS,
  NOT_PAIRED_REASON,
  PHONE_FRAME_MAX_BYTES,
  SealedChannel,
  branchForThread,
  newPairingKey,
  newSealHello,
  parseSealHello,
  type Thread,
} from "@lemonlime/protocol";
import {
  RunnerClient,
  forgetPairing,
  loadPairingKey,
  savePairing,
  sealedWebSocket,
  type ConnectionState,
  type PairingStorage,
  type SealRefusal,
} from "../src/index.ts";

const COMPUTER = "computer-0123456789abcdef";
const THREAD = "thread-aaaaaa";

afterEach(() => vi.useRealTimers());

/** A stand-in for the connection to the bridge, driven by hand. Nothing touches the network. */
function fakeSockets() {
  const made: FakeSocket[] = [];
  class FakeSocket {
    readyState = 0;
    readonly sent: string[] = [];
    closedWith: { code?: number; reason?: string } | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      made.push(this);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(code?: number, reason?: string): void {
      if (this.readyState === 3) return;
      this.closedWith = { code, reason };
      this.drop(code ?? 1000, reason ?? "");
    }
    /** The bridge accepts the connection. */
    accept(): void {
      this.readyState = 1;
      this.onopen?.();
    }
    /** A frame arrives. */
    say(raw: string): void {
      this.onmessage?.({ data: raw });
    }
    /** The other end closes the connection. */
    drop(code: number, reason = ""): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code, reason }));
    }
  }
  return { made, WebSocketImpl: FakeSocket as unknown as typeof WebSocket };
}

/** Wait for something that takes a few turns of real work (deriving keys, sealing). */
async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error("timed out waiting");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** A phone's sealed connection over a fake one, with everything it reports written down. */
function phone(key = newPairingKey()) {
  const { made, WebSocketImpl } = fakeSockets();
  const refused: SealRefusal[] = [];
  const Sealed = sealedWebSocket({ key, computerId: COMPUTER, threadId: THREAD, WebSocketImpl, onRefused: why => refused.push(why) });
  const socket = new Sealed("wss://bridge.example/api/phone/ws/c/t");
  const got: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  let opened = 0;
  socket.onopen = () => opened++;
  socket.onmessage = ev => got.push(String(ev.data));
  socket.onclose = ev => closes.push({ code: ev.code, reason: ev.reason });
  const wire = made[0]!;
  return { key, socket, wire, got, closes, refused, opened: () => opened, Sealed, made };
}

/** The computer's end: reads the phone's hello off the wire and answers with its own. */
async function computerAnswers(wire: { sent: string[]; say(raw: string): void }, key: string): Promise<SealedChannel> {
  const theirs = parseSealHello(wire.sent[1]!)!;
  const mine = newSealHello();
  const channel = await SealedChannel.start({
    key,
    computerId: COMPUTER,
    threadId: THREAD,
    phoneNonce: theirs.nonce,
    computerNonce: mine.nonce,
    side: "computer",
  });
  wire.say(JSON.stringify(mine));
  return channel;
}

const HELLO = JSON.stringify({ type: "hello", token: "ticket-1", resumeFrom: 7 });

describe("pairing keys kept in a browser", () => {
  function storage(): PairingStorage & { kept: Map<string, string> } {
    const kept = new Map<string, string>();
    return { kept, getItem: k => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: k => void kept.delete(k) };
  }

  it("are kept per computer and found again", () => {
    const store = storage();
    const key = newPairingKey();
    expect(loadPairingKey(COMPUTER, store)).toBeNull();
    expect(savePairing({ computerId: COMPUTER, key }, store)).toBe(true);
    expect(loadPairingKey(COMPUTER, store)).toBe(key);
    expect(loadPairingKey("computer-fedcba9876543210", store)).toBeNull();
  });

  it("are replaced when the computer is paired again, and gone when it is unpaired", () => {
    const store = storage();
    const [first, second] = [newPairingKey(), newPairingKey()];
    savePairing({ computerId: COMPUTER, key: first }, store);
    savePairing({ computerId: COMPUTER, key: second }, store);
    expect(loadPairingKey(COMPUTER, store)).toBe(second);
    forgetPairing(COMPUTER, store);
    expect(loadPairingKey(COMPUTER, store)).toBeNull();
  });

  it("are not kept when they aren't pairing keys, or the computer isn't one", () => {
    const store = storage();
    expect(savePairing({ computerId: COMPUTER, key: "not a key" }, store)).toBe(false);
    expect(savePairing({ computerId: "x", key: newPairingKey() }, store)).toBe(false);
    expect(store.kept.size).toBe(0);
  });

  it("say so when the browser won't keep anything", () => {
    const full: PairingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage is off");
      },
      removeItem: () => undefined,
    };
    expect(savePairing({ computerId: COMPUTER, key: newPairingKey() }, full)).toBe(false);
    expect(savePairing({ computerId: COMPUTER, key: newPairingKey() }, null)).toBe(false);
    expect(loadPairingKey(COMPUTER, null)).toBeNull();
  });

  it("ignore something in storage that isn't a pairing key", () => {
    const store = storage();
    store.kept.set(`lemonlime:phone-pairing:${COMPUTER}`, "garbage");
    expect(loadPairingKey(COMPUTER, store)).toBeNull();
  });
});

describe("a phone's sealed connection", () => {
  it("shows the bridge its ticket, says hello, and holds everything else until the computer has said hello", async () => {
    const { key, socket, wire, opened } = phone();
    wire.accept();
    expect(opened()).toBe(1);
    socket.send(HELLO);
    socket.send(JSON.stringify({ type: "send_message", text: "fix the login page", clientMsgId: "m1" }));

    expect(wire.sent).toHaveLength(2);
    // The bridge's part: the ticket, and nothing else of the hello.
    expect(JSON.parse(wire.sent[0]!)).toEqual({ type: "hello", token: "ticket-1" });
    expect(parseSealHello(wire.sent[1]!)).not.toBeNull();

    const computer = await computerAnswers(wire, key);
    await until(() => wire.sent.length === 4);
    for (const frame of wire.sent.slice(2)) {
      expect(JSON.parse(frame)).toMatchObject({ type: "e2e" });
      expect(frame).not.toContain("login");
      expect(frame).not.toContain("ticket-1");
    }
    // Under the seal: the rest of the hello (the ticket isn't the computer's business), then the message.
    expect(JSON.parse((await computer.open(wire.sent[2]!))!)).toEqual({ type: "hello", resumeFrom: 7 });
    expect(JSON.parse((await computer.open(wire.sent[3]!))!)).toEqual({ type: "send_message", text: "fix the login page", clientMsgId: "m1" });
  });

  it("opens what the computer seals and passes it on as the plain frames it stands for", async () => {
    const { key, socket, wire, got } = phone();
    wire.accept();
    socket.send(HELLO);
    const computer = await computerAnswers(wire, key);
    for (const message of ['{"type":"caught_up","latestSeq":0}', '{"type":"pong"}']) for (const frame of await computer.seal(message)) wire.say(frame);
    await until(() => got.length === 2);
    expect(got).toEqual(['{"type":"caught_up","latestSeq":0}', '{"type":"pong"}']);
  });

  it("puts a long message from the computer back together", async () => {
    const { key, socket, wire, got } = phone();
    wire.accept();
    socket.send(HELLO);
    const computer = await computerAnswers(wire, key);
    const long = JSON.stringify({ type: "event", text: "y".repeat(PHONE_FRAME_MAX_BYTES * 2) });
    const frames = await computer.seal(long);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) wire.say(frame);
    await until(() => got.length === 1);
    expect(got[0] === long).toBe(true);
  });

  it("gives up, and passes nothing on, when the answer isn't sealed", async () => {
    const { socket, wire, got, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    // What a computer that doesn't seal would send back: the runner's own frames.
    wire.say(JSON.stringify({ type: "welcome", latestSeq: 3 }));
    wire.say(JSON.stringify({ type: "event", event: { seq: 1 } }));
    await until(() => closes.length === 1);
    expect(got).toEqual([]);
    expect(refused).toEqual(["unprotected"]);
    expect(closes[0]!.code).toBe(BRIDGE_CLOSE.notPaired);
    expect(wire.closedWith).not.toBeNull();
    expect(socket.readyState).toBe(3);
  });

  it("gives up when a frame arrives unsealed in the middle of a sealed session", async () => {
    const { key, socket, wire, got, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    const computer = await computerAnswers(wire, key);
    for (const frame of await computer.seal('{"type":"pong"}')) wire.say(frame);
    wire.say(JSON.stringify({ type: "event", event: { seq: 1, type: "agent_message", text: "slipped in" } }));
    for (const frame of await computer.seal('{"type":"pong"}')) wire.say(frame);
    await until(() => closes.length === 1);
    expect(got).toEqual(['{"type":"pong"}']);
    expect(refused).toEqual(["unprotected"]);
  });

  it("gives up when a sealed frame is played again", async () => {
    const { key, socket, wire, got, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    const computer = await computerAnswers(wire, key);
    const [frame] = await computer.seal('{"type":"pong"}');
    wire.say(frame!);
    wire.say(frame!);
    await until(() => closes.length === 1);
    expect(got).toEqual(['{"type":"pong"}']);
    expect(refused).toEqual(["unprotected"]);
  });

  it("gives up when the computer's frames were sealed with another key", async () => {
    const { socket, wire, got, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    const stranger = await computerAnswers(wire, newPairingKey());
    for (const frame of await stranger.seal('{"type":"welcome"}')) wire.say(frame);
    await until(() => closes.length === 1);
    expect(got).toEqual([]);
    expect(refused).toEqual(["unprotected"]);
  });

  it("says the phone isn't paired when the computer turns it away", async () => {
    const { socket, wire, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    wire.drop(BRIDGE_CLOSE.notPaired, NOT_PAIRED_REASON);
    await until(() => closes.length === 1);
    expect(refused).toEqual(["not-paired"]);
    expect(closes[0]).toEqual({ code: BRIDGE_CLOSE.notPaired, reason: NOT_PAIRED_REASON });
  });

  it("still knows it was turned away when only the reason made it through", async () => {
    const { socket, wire, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    wire.drop(1000, NOT_PAIRED_REASON);
    await until(() => closes.length === 1);
    expect(refused).toEqual(["not-paired"]);
    expect(closes[0]!.code).toBe(BRIDGE_CLOSE.notPaired);
  });

  it("passes any other close on as it is", async () => {
    const { socket, wire, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    wire.drop(BRIDGE_CLOSE.tokenExpired, "ticket ran out");
    await until(() => closes.length === 1);
    expect(closes[0]).toEqual({ code: BRIDGE_CLOSE.tokenExpired, reason: "ticket ran out" });
    expect(refused).toEqual([]);
  });

  it("sends nothing more once it is closed", async () => {
    const { key, socket, wire, closes } = phone();
    wire.accept();
    socket.send(HELLO);
    await computerAnswers(wire, key);
    await until(() => wire.sent.length === 3);
    socket.close(1000, "client closed");
    await until(() => closes.length === 1);
    socket.send('{"type":"interrupt"}');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(wire.sent).toHaveLength(3);
    expect(wire.closedWith).toEqual({ code: 1000, reason: "client closed" });
  });

  it("doesn't wait forever for a computer that never says hello", async () => {
    vi.useFakeTimers();
    const { socket, wire, closes, refused } = phone();
    wire.accept();
    socket.send(HELLO);
    await vi.advanceTimersByTimeAsync(BRIDGE_HELLO_MS + 1);
    expect(wire.closedWith).toEqual({ code: 1000, reason: "no answer" });
    expect(closes).toHaveLength(1);
    // Nothing says the pairing is wrong: the connection may simply be tried again.
    expect(refused).toEqual([]);
  });
});

describe("RunnerClient over a sealed connection", () => {
  function welcome(latestSeq: number) {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: THREAD,
      title: "",
      agent: { kind: "claude-code" },
      repo: { url: "x", baseBranch: "main" },
      branch: branchForThread(THREAD),
      mode: "local",
      status: "idle",
      sandboxSize: "small",
      latestSeq,
      createdAt: now,
      updatedAt: now,
    };
    return JSON.stringify({ type: "welcome", thread, latestSeq, runnerVersion: "t" });
  }

  it("goes live and sends its messages sealed, as if it were talking to the runner itself", async () => {
    const key = newPairingKey();
    const { made, WebSocketImpl } = fakeSockets();
    const states: ConnectionState[] = [];
    const client = new RunnerClient({
      url: "wss://bridge.example/ws",
      token: "ticket-1",
      resumeFrom: 4,
      WebSocketImpl: sealedWebSocket({ key, computerId: COMPUTER, threadId: THREAD, WebSocketImpl }),
      onState: s => states.push(s),
    });
    client.connect();
    await until(() => made.length === 1);
    const wire = made[0]!;
    wire.accept();
    const computer = await computerAnswers(wire, key);
    await until(() => wire.sent.length === 3);
    expect(JSON.parse((await computer.open(wire.sent[2]!))!)).toEqual({ type: "hello", resumeFrom: 4 });

    for (const message of [welcome(4), JSON.stringify({ type: "caught_up", latestSeq: 4 })]) for (const frame of await computer.seal(message)) wire.say(frame);
    await until(() => states.includes("live"));
    client.send("carry on", "m1");
    await until(() => wire.sent.length === 4);
    expect(wire.sent[3]).not.toContain("carry on");
    expect(JSON.parse((await computer.open(wire.sent[3]!))!)).toMatchObject({ type: "send_message", text: "carry on", clientMsgId: "m1" });
    client.close();
  });

  it("stops trying, and says why, when the computer turns the phone away", async () => {
    const { made, WebSocketImpl } = fakeSockets();
    const states: ConnectionState[] = [];
    const errors: Array<[string, string | undefined]> = [];
    const refused: SealRefusal[] = [];
    const client = new RunnerClient({
      url: "wss://bridge.example/ws",
      token: async () => "ticket-1",
      WebSocketImpl: sealedWebSocket({ key: newPairingKey(), computerId: COMPUTER, threadId: THREAD, WebSocketImpl, onRefused: why => refused.push(why) }),
      onState: s => states.push(s),
      onError: (message, code) => errors.push([message, code]),
      maxBackoffMs: 10,
    });
    client.connect();
    await until(() => made.length === 1);
    made[0]!.accept();
    made[0]!.drop(BRIDGE_CLOSE.notPaired, NOT_PAIRED_REASON);
    await until(() => states.at(-1) === "closed");
    expect(errors).toEqual([[NOT_PAIRED_REASON, "not_paired"]]);
    expect(refused).toEqual(["not-paired"]);
    // No second attempt, however long it waits.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(made).toHaveLength(1);
    client.reconnectNow();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(made).toHaveLength(1);
  });
});
