import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { RunnerClient } from "@lemonlime/client";
import { branchForThread, type LocalThreadSnapshot, type Thread, type ThreadEvent } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../../../packages/runner/src/index.ts";
import { PhoneLink } from "../../desktop/src/lib/phoneBridge.ts";
import { computerThreadResponse, linkTicket, saveComputer } from "../src/lib/computers.ts";
import { createNodePhoneBridge } from "../src/lib/phone-bridge-node.ts";
import { TEST_ENV, addUser, createTestApp } from "./helpers.ts";

/**
 * The whole path, with the real pieces: the dashboard's RunnerClient on a "phone" → the
 * control plane's Node hub → the desktop app's PhoneLink → a runner on loopback. The
 * runner protocol and client are the same as for any other thread; only the URL differs.
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
  const thread: Thread = {
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
  };
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

describe("phone access end to end", () => {
  it("drives a local thread from the phone, and turning it off cuts the phone", async () => {
    const runnerPort = await bootRunner();

    // The control plane, with its Node hub on a real port.
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

    // The desktop app.
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
    const states: string[] = [];
    let runnerCalls = 0;
    const link = new PhoneLink({
      api: {
        saveComputer: async (id, body) => saveComputer(ctx, bridge.control, owner.userId, owner.workspaceId, id, body),
        phoneLink: async id => linkTicket(ctx, bridge.control, owner.userId, id),
      },
      computer: { id: COMPUTER, name: "Test Mac", platform: "mac" },
      threads: () => [shared],
      runner: async id => (runnerCalls++, id === THREAD ? { port: runnerPort, secret: SECRET } : null),
      onState: s => states.push(s),
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    link.start();
    cleanups.push(() => link.stop({ tell: false }));
    await waitFor(() => states.includes("live"));

    // The phone: the dashboard's ThreadView asks the control plane for an endpoint.
    const endpoint = async () => (await computerThreadResponse(ctx, bridge.control, owner.userId, COMPUTER, THREAD)).endpoint;
    const first = await endpoint();
    expect(first?.url).toBe(`${base}/api/phone/ws/${COMPUTER}/${THREAD}`);
    const events: ThreadEvent[] = [];
    const conn: string[] = [];
    const closes: number[] = [];
    const Tracking = class extends (WebSocket as unknown as typeof globalThis.WebSocket) {
      constructor(url: string | URL) {
        super(url);
        this.addEventListener("close", ev => closes.push(ev.code));
      }
    };
    const phone = new RunnerClient({
      url: first!.url,
      token: async () => (await endpoint())?.token ?? Promise.reject(new Error("offline")),
      WebSocketImpl: Tracking as unknown as typeof globalThis.WebSocket,
      onEvent: e => events.push(e),
      onState: s => conn.push(s),
      maxBackoffMs: 60_000,
    });
    phone.connect();
    cleanups.push(() => phone.close());
    await waitFor(() => conn.includes("live"));
    expect(runnerCalls).toBe(1);

    phone.send("hi from the phone", "m1");
    await waitFor(() => events.some(e => e.type === "agent_message"));
    expect(events.some(e => e.type === "user_message" && e.text === "hi from the phone")).toBe(true);
    expect(link.phoneSessions).toBe(1);

    // Turn phone access off on the desktop: the phone is cut at once and can't come back.
    await link.stop();
    await waitFor(() => closes.length > 0);
    expect(link.phoneSessions).toBe(0);
    expect(await endpoint().catch(() => null)).toBeNull();
    expect(await bridge.control.linked(COMPUTER)).toBe(false);
  });
});

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 20));
  }
}
