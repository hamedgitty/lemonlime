import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  BRIDGE_CLOSE,
  LINK_TICKET_SECONDS,
  MAX_PHONES_PER_THREAD,
  PHONE_FRAME_MAX_BYTES,
  PHONE_IDLE_MS,
  PHONE_TICKET_SECONDS,
  deriveBridgeKey,
  signBridgeTicket,
  type BridgeTicket,
} from "@lemonlime/protocol";
import { createNodePhoneBridge, type NodePhoneBridge } from "../src/lib/phone-bridge-node.ts";
import { computerThreadResponse, linkTicket, saveComputer } from "../src/lib/computers.ts";
import { addUser, createTestApp } from "./helpers.ts";
import { BridgeHub, bridgePath, pendingPeer, type Peer as HubPeer } from "../src/lib/phone-bridge.ts";

/** The phone bridge's in-process hub (Node): tickets, piping, caps, turning off. */

const SECRET = "test-master-secret-0123456789abcdef";
const COMPUTER = "computer-0123456789abcdef";
const THREAD = "thread-aaaaaa";
const USER = "user-1";

let clock = Date.now();
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<{ bridge: NodePhoneBridge; base: string }> {
  clock = Date.now();
  const bridge = createNodePhoneBridge({ masterSecret: () => SECRET, now: () => clock, sweepMs: 60_000 });
  const server: Server = createServer((_req, res) => res.end("not here"));
  server.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  cleanups.push(
    () => new Promise<void>(r => server.close(() => r())),
    () => bridge.close(),
  );
  return { bridge, base: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const sec = () => Math.floor(clock / 1000);
async function ticket(t: Partial<BridgeTicket> & { kind: "link" | "phone" }, secret = SECRET): Promise<string> {
  const base =
    t.kind === "link"
      ? { kind: "link" as const, computerId: COMPUTER, userId: USER, epoch: 0, exp: sec() + LINK_TICKET_SECONDS }
      : { kind: "phone" as const, computerId: COMPUTER, threadId: THREAD, userId: USER, epoch: 0, exp: sec() + PHONE_TICKET_SECONDS };
  return signBridgeTicket({ ...base, ...t } as BridgeTicket, await deriveBridgeKey(secret));
}

interface Peer {
  ws: WebSocket;
  got: string[];
  closed: Promise<number>;
  next: (match?: (m: string) => boolean) => Promise<string>;
}

function connect(url: string, first?: string): Peer {
  const ws = new WebSocket(url);
  const got: string[] = [];
  const waiters: Array<() => void> = [];
  ws.on("open", () => first && ws.send(first));
  ws.on("message", raw => {
    got.push(raw.toString());
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<number>(r => ws.on("close", code => r(code)));
  cleanups.push(() => ws.terminate());
  let seen = 0;
  const next = (match: (m: string) => boolean = () => true) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(got)}`)), 3000);
      const check = () => {
        while (seen < got.length) {
          const m = got[seen++]!;
          if (match(m)) {
            clearTimeout(timer);
            return resolve(m);
          }
        }
        waiters.push(check);
      };
      check();
    });
  return { ws, got, closed, next };
}

async function link(base: string, t?: string): Promise<Peer> {
  const l = connect(`${base}/api/phone/link/${COMPUTER}`, JSON.stringify({ type: "auth", ticket: t ?? (await ticket({ kind: "link" })) }));
  await l.next(m => JSON.parse(m).type === "linked");
  return l;
}

async function phone(base: string, t?: string, thread = THREAD): Promise<Peer> {
  return connect(`${base}/api/phone/ws/${COMPUTER}/${thread}`, JSON.stringify({ type: "hello", token: t ?? (await ticket({ kind: "phone" })), resumeFrom: 7 }));
}

const isType = (type: string) => (m: string) => JSON.parse(m).type === type;

describe("phone bridge (Node hub)", () => {
  it("answers only its own paths", () => {
    expect(bridgePath(`/api/phone/link/${COMPUTER}`)).toEqual({ kind: "link", computerId: COMPUTER });
    expect(bridgePath(`/api/phone/ws/${COMPUTER}/${THREAD}`)).toEqual({ kind: "phone", computerId: COMPUTER, threadId: THREAD });
    expect(bridgePath("/api/phone/ws/x/y")).toBeNull();
    expect(bridgePath(`/api/phone/link/${COMPUTER}/extra`)).toBeNull();
  });

  it("pipes frames both ways, with the phone's ticket kept from the computer", async () => {
    const { base } = await boot();
    const l = await link(base);
    const p = await phone(base);
    const open = JSON.parse(await l.next(isType("open"))) as { session: string; threadId: string; userId: string };
    expect(open).toMatchObject({ threadId: THREAD, userId: USER });
    const hello = JSON.parse(await l.next(isType("data"))) as { session: string; data: string };
    expect(hello.session).toBe(open.session);
    // The hello arrives without the ticket; the desktop app adds its own runner token.
    expect(JSON.parse(hello.data)).toEqual({ type: "hello", resumeFrom: 7 });

    l.ws.send(JSON.stringify({ type: "data", session: open.session, data: '{"type":"welcome"}' }));
    expect(await p.next()).toBe('{"type":"welcome"}');
    p.ws.send('{"type":"send_message","text":"hi"}');
    const up = JSON.parse(await l.next(isType("data"))) as { data: string };
    expect(up.data).toBe('{"type":"send_message","text":"hi"}');

    // The runner closing (its token ran out) closes the phone with the same code.
    l.ws.send(JSON.stringify({ type: "end", session: open.session, code: 4001 }));
    expect(await p.closed).toBe(4001);
  });

  it("tells the computer when a phone leaves", async () => {
    const { base } = await boot();
    const l = await link(base);
    const p = await phone(base);
    const open = JSON.parse(await l.next(isType("open"))) as { session: string };
    p.ws.close();
    expect(JSON.parse(await l.next(isType("end")))).toEqual({ type: "end", session: open.session });
  });

  it.each([
    ["for another thread", () => ticket({ kind: "phone", threadId: "thread-bbbbbb" })],
    ["for another computer", () => ticket({ kind: "phone", computerId: "computer-ffffffffffffffff" })],
    ["expired", () => ticket({ kind: "phone", exp: sec() - 1 })],
    ["forged", () => ticket({ kind: "phone" }, "a-different-master-secret-000000000")],
    ["of the wrong kind (a link ticket)", () => ticket({ kind: "link" })],
    ["for another user", () => ticket({ kind: "phone", userId: "user-2" })],
    ["from before phone access was turned off", () => ticket({ kind: "phone", epoch: 3 })],
  ])("refuses a phone ticket %s", async (_label, make) => {
    const { base } = await boot();
    const l = await link(base);
    const p = await phone(base, await make());
    expect(await p.closed).toBe(BRIDGE_CLOSE.unauthorized);
    expect(l.got.some(isType("open"))).toBe(false);
  });

  it("refuses a link without a good ticket", async () => {
    const { base } = await boot();
    const bad = connect(`${base}/api/phone/link/${COMPUTER}`, JSON.stringify({ type: "auth", ticket: await ticket({ kind: "phone" }) }));
    expect(await bad.closed).toBe(BRIDGE_CLOSE.unauthorized);
    const other = connect(
      `${base}/api/phone/link/${COMPUTER}`,
      JSON.stringify({ type: "auth", ticket: await ticket({ kind: "link", computerId: "computer-ffffffffffffffff" }) }),
    );
    expect(await other.closed).toBe(BRIDGE_CLOSE.unauthorized);
  });

  it("says the computer is offline when it has no link", async () => {
    const { base } = await boot();
    const p = await phone(base);
    expect(await p.closed).toBe(BRIDGE_CLOSE.offline);
  });

  it("caps phone frames", async () => {
    const { base } = await boot();
    const l = await link(base);
    const p = await phone(base);
    await l.next(isType("open"));
    p.ws.send("x".repeat(PHONE_FRAME_MAX_BYTES + 1));
    expect(await p.closed).toBe(BRIDGE_CLOSE.tooBig);
  });

  it("caps frames in the hub itself too (as on Workers, where nothing else does)", async () => {
    type Fake = { sent: string[]; closed: number | null; send(d: string): void; close(c: number): void };
    const peers = new Map<Fake, HubPeer>();
    const make = (): Fake => ({
      sent: [],
      closed: null,
      send(d) {
        this.sent.push(d);
      },
      close(c) {
        this.closed = c;
      },
    });
    const hub = new BridgeHub<Fake>(
      { sockets: () => peers.keys(), peer: s => peers.get(s) ?? null, setPeer: (s, p) => peers.set(s, p), now: () => clock, newId: () => "s1" },
      () => deriveBridgeKey(SECRET),
    );
    const l = make();
    peers.set(l, pendingPeer({ kind: "link", computerId: COMPUTER }, clock));
    await hub.message(l, JSON.stringify({ type: "auth", ticket: await ticket({ kind: "link" }) }));
    const p = make();
    peers.set(p, pendingPeer({ kind: "phone", computerId: COMPUTER, threadId: THREAD }, clock));
    await hub.message(p, JSON.stringify({ type: "hello", token: await ticket({ kind: "phone" }) }));
    expect(peers.get(p)?.role).toBe("phone");
    await hub.message(p, "x".repeat(PHONE_FRAME_MAX_BYTES + 1));
    expect(p.closed).toBe(BRIDGE_CLOSE.tooBig);
    expect(l.sent.at(-1)).toBe(JSON.stringify({ type: "end", session: "s1" }));
  });

  it("lets only a few phones open one thread", async () => {
    const { base } = await boot();
    const l = await link(base);
    for (let i = 0; i < MAX_PHONES_PER_THREAD; i++) {
      await phone(base);
      await l.next(isType("open"));
    }
    const extra = await phone(base);
    expect(await extra.closed).toBe(BRIDGE_CLOSE.busy);
  });

  it("cuts every phone at once when phone access is turned off", async () => {
    const { base, bridge } = await boot();
    const l = await link(base);
    const a = await phone(base);
    const b = await phone(base);
    await l.next(isType("open"));
    await l.next(isType("open"));
    await bridge.control.kill(COMPUTER);
    expect(await a.closed).toBe(BRIDGE_CLOSE.turnedOff);
    expect(await b.closed).toBe(BRIDGE_CLOSE.turnedOff);
    expect(await l.closed).toBe(BRIDGE_CLOSE.turnedOff);
    expect(await bridge.control.linked(COMPUTER)).toBe(false);
  });

  it("closes phones when the computer goes away, and a newer link replaces an older one", async () => {
    const { base, bridge } = await boot();
    const first = await link(base);
    const p = await phone(base);
    await first.next(isType("open"));
    const second = await link(base);
    expect(await first.closed).toBe(BRIDGE_CLOSE.replaced);
    expect(await p.closed).toBe(BRIDGE_CLOSE.offline);
    expect(await bridge.control.linked(COMPUTER)).toBe(true);
    second.ws.close();
    await second.closed;
    await new Promise(r => setTimeout(r, 50));
    expect(await bridge.control.linked(COMPUTER)).toBe(false);
  });

  it("closes phones at their ticket's expiry and when idle", async () => {
    const { base, bridge } = await boot();
    const l = await link(base);
    const p = await phone(base, await ticket({ kind: "phone", exp: sec() + 60 }));
    await l.next(isType("open"));
    clock += 61_000;
    bridge.hub.sweep();
    expect(await p.closed).toBe(BRIDGE_CLOSE.tokenExpired);

    l.ws.send('{"type":"ping"}');
    await l.next(isType("pong"));
    const q = await phone(base);
    await l.next(isType("open"));
    clock += PHONE_IDLE_MS + 1000;
    l.ws.send('{"type":"ping"}'); // the link stays alive...
    await l.next(isType("pong"));
    bridge.hub.sweep();
    expect(await q.closed).toBe(BRIDGE_CLOSE.idle); // ...the silent phone doesn't
  });

  it("renews a link's ticket on the open link", async () => {
    const { base, bridge } = await boot();
    const l = await link(base, await ticket({ kind: "link", exp: sec() + 60 }));
    l.ws.send(JSON.stringify({ type: "renew", ticket: await ticket({ kind: "link" }) }));
    l.ws.send('{"type":"ping"}');
    await l.next(isType("pong"));
    clock += 61_000;
    l.ws.send('{"type":"ping"}');
    await l.next(isType("pong"));
    bridge.hub.sweep();
    expect(await bridge.control.linked(COMPUTER)).toBe(true);
    // A renewal for another epoch is refused.
    l.ws.send(JSON.stringify({ type: "renew", ticket: await ticket({ kind: "link", epoch: 1 }) }));
    expect(await l.closed).toBe(BRIDGE_CLOSE.unauthorized);
  });

  it("turning phone access off on the desktop cuts a live phone session, end to end", async () => {
    const { base, bridge } = await boot();
    const { ctx, db } = await createTestApp();
    const owner = await addUser(db, "owner@example.com");
    const now = new Date(clock).toISOString();
    const shared = {
      id: THREAD,
      title: "T",
      agent: { kind: "codex" as const },
      repoName: "app",
      branch: "agent/x",
      status: "idle" as const,
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    const save = (phoneAccess: boolean) =>
      saveComputer(ctx, bridge.control, owner.userId, owner.workspaceId, COMPUTER, { name: "Mac", platform: "mac", phoneAccess, threads: [shared] }, clock);
    await save(true);
    const t = await linkTicket(ctx, bridge.control, owner.userId, COMPUTER, clock);
    const l = await link(base, t.ticket);
    const res = await computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, THREAD, clock);
    const p = await phone(base, res.endpoint!.token);
    await l.next(isType("open"));
    await save(false);
    expect(await p.closed).toBe(BRIDGE_CLOSE.turnedOff);
    expect(await l.closed).toBe(BRIDGE_CLOSE.turnedOff);
  });
});
