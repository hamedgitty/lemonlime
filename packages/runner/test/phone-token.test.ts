import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchForThread, signToken, type Thread, type TokenClaims } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

/** Phone (bridged) connections: the runner checks their tokens itself and gives them fewer powers. */

const SECRET = "thread-secret-for-phone-tests-01234";
const THREAD = "phone-thread-1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot() {
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
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
  const idle: AgentAdapter = { kind: "claude-code", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t" });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return { port: server.port, runner };
}

const now = () => Math.floor(Date.now() / 1000);
const phoneToken = (over: Partial<TokenClaims> = {}, secret = SECRET) =>
  signToken({ threadId: THREAD, scope: "phone", sub: "user-1", exp: now() + 600, ...over }, secret);

interface Session {
  messages: Array<{ type: string; code?: string; message?: string }>;
  closed: Promise<number>;
  ws: WebSocket;
  until: (type: string) => Promise<void>;
}

function open(port: number, path: string, hello: Record<string, unknown>): Session {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const messages: Session["messages"] = [];
  const waiters: Array<() => void> = [];
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  ws.on("message", raw => {
    messages.push(JSON.parse(raw.toString()) as Session["messages"][number]);
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<number>(resolve => ws.on("close", code => resolve(code)));
  cleanups.push(() => ws.terminate());
  const until = (type: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type}`)), 3000);
      const check = () => {
        if (messages.some(m => m.type === type)) {
          clearTimeout(timer);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  return { messages, closed, ws, until };
}

describe("phone tokens on the runner", () => {
  it("lets a phone token open the thread", async () => {
    const { port } = await boot();
    const s = open(port, "/ws", { type: "hello", token: await phoneToken(), resumeFrom: 0 });
    await s.until("caught_up");
    expect(s.messages[0]?.type).toBe("welcome");
  });

  it.each([
    ["for another thread", () => phoneToken({ threadId: "other-thread-9" })],
    ["expired", () => phoneToken({ exp: now() - 5 })],
    ["forged (signed with another secret)", () => phoneToken({}, "not-the-thread-secret-at-all-0000")],
    ["too long-lived", () => phoneToken({ exp: now() + 24 * 3600 })],
  ])("refuses a phone token %s", async (_label, make) => {
    const { port } = await boot();
    const s = open(port, "/ws", { type: "hello", token: await make(), resumeFrom: 0 });
    expect(await s.closed).toBe(4401);
    expect(s.messages.some(m => m.type === "welcome")).toBe(false);
  });

  it("refuses a tampered token", async () => {
    const { port } = await boot();
    const good = await phoneToken();
    const [payload, sig] = good.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...claims, scope: "client" })).toString("base64url")}.${sig}`;
    const s = open(port, "/ws", { type: "hello", token: forged, resumeFrom: 0 });
    expect(await s.closed).toBe(4401);
  });

  it("never offers a phone the computer, sign-in or full access", async () => {
    const { port, runner } = await boot();
    runner.setOptions({ permission: "edits" });
    const s = open(port, "/ws", { type: "hello", token: await phoneToken(), resumeFrom: 0, computer: true });
    await s.until("caught_up");
    for (const m of [
      { type: "computer_result", requestId: "r1", ok: true, output: "x" },
      { type: "start_login" },
      { type: "login_input", text: "code" },
      { type: "set_options", permission: "full" },
    ])
      s.ws.send(JSON.stringify(m));
    await new Promise(r => setTimeout(r, 200));
    const errors = s.messages.filter(m => m.type === "error");
    expect(errors).toHaveLength(4);
    expect(errors.every(e => e.code === "bad_request")).toBe(true);
    // Asking for the computer in the hello did nothing: no request can reach this connection.
    expect(runner.computer.available).toBe(false);
    expect(runner.currentOptions.permission).toBe("edits");
    // Safer modes are fine.
    s.ws.send(JSON.stringify({ type: "set_options", permission: "plan" }));
    await new Promise(r => setTimeout(r, 200));
    expect(s.messages.filter(m => m.type === "error")).toHaveLength(4);
  });

  it("refuses whatever a phone isn't listed for: going back, side chats, offering a port", async () => {
    const { port, runner } = await boot();
    const s = open(port, "/ws", { type: "hello", token: await phoneToken(), resumeFrom: 0 });
    await s.until("caught_up");
    const refused = [
      { type: "rewind", toSeq: 1, restoreFiles: true },
      { type: "side_ask", text: "what does this do?" },
      { type: "side_pin", sideId: "s1", pinned: true },
      { type: "side_open", sideId: "s1" },
      { type: "side_close", sideId: "s1" },
      { type: "offer_preview", port: 5173 },
      { type: "cancel_login" },
    ];
    for (const m of refused) s.ws.send(JSON.stringify(m));
    await new Promise(r => setTimeout(r, 200));
    const errors = s.messages.filter(m => m.type === "error");
    expect(errors).toHaveLength(refused.length);
    expect(errors.every(e => e.code === "bad_request" && e.message === "That can only be done on the computer itself.")).toBe(true);
    expect(s.messages.some(m => m.type === "side_started" || m.type === "side_history")).toBe(false);
    expect(runner.side.list()).toEqual([]);
  });

  it("lets a phone do what its page offers: talk to the agent, stop it, answer it, change how it runs", async () => {
    const { port, runner } = await boot();
    const s = open(port, "/ws", { type: "hello", token: await phoneToken(), resumeFrom: 0 });
    await s.until("caught_up");
    for (const m of [
      { type: "send_message", text: "hello from the phone", clientMsgId: "m1" },
      { type: "interrupt" },
      { type: "approve", requestId: "r1", decision: "allow" },
      { type: "answer_question", requestId: "q1", answers: null },
      { type: "edit_queue", clientMsgId: "m9", action: "remove" },
      { type: "set_options", permission: "plan" },
      { type: "limit_action", action: "wait" },
      { type: "compact" },
      { type: "continue_after_restart" },
      { type: "ping" },
    ])
      s.ws.send(JSON.stringify(m));
    await s.until("ack");
    await s.until("pong");
    await new Promise(r => setTimeout(r, 200));
    expect(s.messages.filter(m => m.message === "That can only be done on the computer itself.")).toEqual([]);
    expect(s.messages.some(m => m.code === "unauthorized")).toBe(false);
    expect(runner.currentOptions.permission).toBe("plan");
  });

  it("still lets a phone message the agent and ping", async () => {
    const { port } = await boot();
    const s = open(port, "/ws", { type: "hello", token: await phoneToken(), resumeFrom: 0 });
    await s.until("caught_up");
    s.ws.send(JSON.stringify({ type: "send_message", text: "hello from the phone", clientMsgId: "m1" }));
    s.ws.send(JSON.stringify({ type: "ping" }));
    await s.until("ack");
    await s.until("pong");
  });

  it("keeps the terminal and the HTTP routes for the user's own apps", async () => {
    const { port } = await boot();
    const term = open(port, "/terminal", { type: "hello", token: await phoneToken(), cols: 80, rows: 24 });
    expect(await term.closed).toBe(4401);
    for (const path of ["/files", "/commands", "/previews", "/git/status"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${await phoneToken()}` } });
      expect(res.status, path).toBe(401);
    }
  });
});
