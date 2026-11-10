import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { RunnerClient, sealedWebSocket, type SealRefusal } from "@lemonlime/client";
import { BRIDGE_CLOSE, NOT_PAIRED_REASON, Thread, branchForThread, newPairingKey, type LocalThreadSnapshot, type ThreadEvent } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../../../packages/runner/src/index.ts";
import { PhoneLink } from "../../desktop/src/lib/phoneBridge.ts";
import { computerThreadResponse, linkTicket, saveComputer } from "../src/lib/computers.ts";
import { createNodePhoneBridge } from "../src/lib/phone-bridge-node.ts";
import { TEST_ENV, addUser, createTestApp } from "./helpers.ts";

/**
 * The whole path, with the real pieces: the dashboard's RunnerClient on a "phone" → the
 * control plane's Node hub → the desktop app's PhoneLink → a runner on loopback. The
 * runner protocol and client are the same as for any other thread; the phone's socket
 * seals what it sends with the key it was paired with, and the desktop app opens it.
 */

const THREAD = "e2e-thread-1";
const COMPUTER = "computer-e2e-0123456789";
const SECRET = "local-thread-secret-for-e2e-0123456";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function bootRunner() {
  const now = new Date().toISOString();
  const thread = Thread.parse({
    id: THREAD,
    title: "",
    agent: { kind: "claude-code" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(THREAD),
    mode: "local",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  });
  const echo: AgentAdapter = {
    kind: "claude-code",
    createSession: () => ({
      runTurn: async turn => {
        turn.emit({ type: "agent_message", text: "hello from the computer" } as never);
      },
      saveState: () => ({}),
      dispose: async () => {},
    }),
  };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: echo, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return server.port;
}

type Sock = typeof globalThis.WebSocket;

/** The runner, the control plane with its Node hub on a real port, and the desktop app linked to it. */
async function world() {
  const runnerPort = await bootRunner();

  const bridge = createNodePhoneBridge({ masterSecret: () => TEST_ENV.LEMONLIME_TOKEN_SECRET });
  const http = createServer((_req, res) => res.end());
  http.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  cleanups.push(
    () => new Promise<void>(r => http.close(() => r())),
    () => bridge.close(),
  );
  const base = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const { ctx, db } = await createTestApp();
  const owner = await addUser(db, "owner@example.com");
  // The server's public URL points at the test port.
  ctx.config.publicUrl = () => base.replace("ws://", "http://");

  // The desktop app, with the pairing key it would keep in the keychain.
  const now = new Date().toISOString();
  const shared: LocalThreadSnapshot = {
    id: THREAD,
    title: "E2E",
    agent: { kind: "claude-code" },
    repoName: "app",
    branch: "agent/x",
    status: "idle",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const pairing = { key: newPairingKey() };
  const states: string[] = [];
  const counts = { runner: 0 };
  const link = new PhoneLink({
    api: {
      saveComputer: async (id, body) => saveComputer(ctx, bridge.control, owner.userId, owner.workspaceId, id, body),
      phoneLink: async id => linkTicket(ctx, bridge.control, owner.userId, id),
    },
    computer: { id: COMPUTER, name: "Test Mac", platform: "mac" },
    threads: () => [shared],
    runner: async id => (counts.runner++, id === THREAD ? { port: runnerPort, secret: SECRET } : null),
    pairingKey: () => pairing.key,
    onState: s => states.push(s),
    WebSocketImpl: WebSocket as unknown as Sock,
  });
  link.start();
  cleanups.push(() => link.stop({ tell: false }));
  await waitFor(() => states.includes("live"));

  /** What the dashboard's thread page asks the control plane for. */
  const page = () => computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, THREAD);
  const endpoint = async () => (await page()).endpoint;

  /** A WebSocket that notes everything that passes through the control plane, both ways. */
  const wire: string[] = [];
  const closes: number[] = [];
  const Wire = class extends (WebSocket as unknown as Sock) {
    constructor(url: string | URL) {
      super(url);
      this.addEventListener("message", ev => wire.push(String(ev.data)));
      this.addEventListener("close", ev => closes.push(ev.code));
    }
    override send(data: string) {
      wire.push(data);
      super.send(data);
    }
  } as unknown as Sock;

  /** The dashboard on a phone that holds `key`. */
  const phone = async (key: string) => {
    const events: ThreadEvent[] = [];
    const conn: string[] = [];
    const errors: Array<{ message: string; code: string | undefined }> = [];
    const refusals: SealRefusal[] = [];
    const first = await endpoint();
    const client = new RunnerClient({
      url: first!.url,
      token: async () => (await endpoint())?.token ?? Promise.reject(new Error("offline")),
      WebSocketImpl: sealedWebSocket({ key, computerId: COMPUTER, threadId: THREAD, onRefused: why => refusals.push(why), WebSocketImpl: Wire }),
      onEvent: e => events.push(e),
      onState: s => conn.push(s),
      onError: (message, code) => errors.push({ message, code }),
      maxBackoffMs: 60_000,
    });
    client.connect();
    cleanups.push(() => client.close());
    return { client, events, conn, errors, refusals };
  };

  return { base, bridge, link, pairing, counts, page, endpoint, wire, closes, Wire, phone };
}

describe("phone access end to end", () => {
  it("drives a local thread from a paired phone, and turning it off cuts the phone", async () => {
    const w = await world();
    const page = await w.page();
    expect(page.endpoint?.url).toBe(`${w.base}/api/phone/ws/${COMPUTER}/${THREAD}`);
    // The dashboard is told this computer only answers paired phones.
    expect(page.computer.sealed).toBe(true);

    const phone = await w.phone(w.pairing.key);
    await waitFor(() => phone.conn.includes("live"));
    expect(w.counts.runner).toBe(1);

    phone.client.send("hi from the phone", "m1");
    await waitFor(() => phone.events.some(e => e.type === "agent_message"));
    expect(phone.events.some(e => e.type === "user_message" && e.text === "hi from the phone")).toBe(true);
    expect(w.link.phoneSessions).toBe(1);
    expect(phone.refusals).toEqual([]);

    // Turn phone access off on the desktop: the phone is cut at once and can't come back.
    await w.link.stop();
    await waitFor(() => w.closes.length > 0);
    expect(w.link.phoneSessions).toBe(0);
    expect(await w.endpoint().catch(() => null)).toBeNull();
    expect(await w.bridge.control.linked(COMPUTER)).toBe(false);
  });

  it("shows the control plane the ticket and nothing of the conversation", async () => {
    const w = await world();
    const phone = await w.phone(w.pairing.key);
    await waitFor(() => phone.conn.includes("live"));
    phone.client.send("the launch code is lemon", "m1");
    await waitFor(() => phone.events.some(e => e.type === "agent_message"));

    // First the ticket, on its own; then a nonce each way; then only sealed frames.
    const frames = w.wire.map(raw => JSON.parse(raw) as Record<string, unknown>);
    expect(Object.keys(frames[0]!).sort()).toEqual(["token", "type"]);
    expect(frames.slice(1, 3).map(f => f.type)).toEqual(["e2e_hello", "e2e_hello"]);
    expect(frames.length).toBeGreaterThan(4);
    expect(frames.slice(3).every(f => f.type === "e2e" && Object.keys(f).sort().join() === "c,n,type")).toBe(true);
    const seen = w.wire.join("\n");
    expect(seen).not.toContain("launch code");
    expect(seen).not.toContain("hello from the computer");
    expect(seen).not.toContain("agent_message");
  });

  it("turns away a phone that isn't paired before anything is started for it", async () => {
    const w = await world();
    const first = await w.endpoint();
    // A dashboard that doesn't seal: its hello, then a message in the open.
    const socket = new w.Wire(first!.url);
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      socket.onclose = ev => resolve({ code: ev.code, reason: ev.reason });
    });
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "hello", token: first!.token, resumeFrom: 0 }));
      socket.send(JSON.stringify({ type: "send_message", text: "let me in", clientMsgId: "m1" }));
    };
    expect(await closed).toEqual({ code: BRIDGE_CLOSE.notPaired, reason: NOT_PAIRED_REASON });
    expect(w.counts.runner).toBe(0);
    expect(w.link.phoneSessions).toBe(0);
    // Nothing came back but the close.
    expect(w.wire.filter(raw => !raw.includes('"token"') && !raw.includes("let me in"))).toEqual([]);
  });

  it("turns away a phone paired before the computer unpaired every phone", async () => {
    const w = await world();
    const old = w.pairing.key;
    w.pairing.key = newPairingKey();
    w.link.unpairPhones();

    const phone = await w.phone(old);
    await waitFor(() => phone.refusals.length > 0);
    expect(phone.refusals).toEqual(["not-paired"]);
    expect(phone.errors).toEqual([{ message: NOT_PAIRED_REASON, code: "not_paired" }]);
    expect(phone.conn).not.toContain("live");
    expect(phone.events).toEqual([]);
    expect(w.counts.runner).toBe(0);
    // It doesn't keep trying.
    await new Promise(r => setTimeout(r, 150));
    expect(w.closes).toEqual([BRIDGE_CLOSE.notPaired]);
  });

  it("cuts a paired phone off the moment the computer unpairs every phone", async () => {
    const w = await world();
    const phone = await w.phone(w.pairing.key);
    await waitFor(() => phone.conn.includes("live"));
    w.pairing.key = newPairingKey();
    w.link.unpairPhones();
    await waitFor(() => phone.refusals.length > 0);
    expect(phone.refusals).toEqual(["not-paired"]);
    expect(w.link.phoneSessions).toBe(0);
  });
});

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 20));
  }
}
