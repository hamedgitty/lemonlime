import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, deriveAgentKey, signToken, type Thread, type TokenClaims } from "@lemonlime/protocol";
import { startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

/** What the runner answers without a token: who may ask, and how much each caller is told. */

const SECRET = "thread-secret-for-status-tests-0123";
const THREAD = "status-thread-1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(over: { host?: string; sandbox?: boolean } = {}) {
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
  const server = await startServer(runner, { host: over.host ?? "127.0.0.1", port: 0, threadSecret: SECRET, version: "9.9.9", sandbox: over.sandbox ?? false });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return server.port;
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/** A request over this machine's own loopback, with whatever `Host` and other headers the caller says. */
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
      let text = "";
      res.on("data", d => (text += String(d)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
    });
    req.on("error", reject);
    req.end();
  });
}

const soon = () => Math.floor(Date.now() / 1000) + 60;
const token = (claims: Partial<TokenClaims> = {}, key = SECRET) => signToken({ threadId: THREAD, scope: "client", exp: soon(), ...claims }, key);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const ALIVE = { ok: true, threadId: THREAD, version: "9.9.9" };

describe("a runner kept to this machine", () => {
  it("tells an app on the same machine everything about the thread, with no token", async () => {
    const port = await boot();
    const res = await get(port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...ALIVE, status: "idle", latestSeq: expect.any(Number), agent: "claude-code", waitingApprovals: 0 });
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(["idleSince", "limit", "account"]));
    expect((await get(port, "/")).body).toMatchObject({ status: "idle" });
  });

  it.each(["127.0.0.1", "localhost", "LOCALHOST:7420", "[::1]", "[::1]:7420", "127.0.0.1:7420"])("answers a request that asks for %s", async host => {
    const port = await boot();
    for (const path of ["/healthz", "/", "/capabilities"]) expect((await get(port, path, { host })).status, path).toBe(200);
  });

  it.each(["evil.example", "evil.example:7420", "127.0.0.1.evil.example", "localhost.evil.example:80", "10.0.0.5:7420"])(
    "refuses a request that asks for another host (%s), as a web page pointing its own name here would",
    async host => {
      const port = await boot();
      for (const path of ["/healthz", "/", "/capabilities", "/nothing-here"]) {
        const res = await get(port, path, { host });
        expect(res.status, path).toBe(403);
        expect(res.body).toEqual({ ok: false, error: "forbidden" });
      }
    },
  );

  it("answers a bare request that names no host, which no web page can send", async () => {
    const port = await boot();
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("GET /healthz HTTP/1.0\r\n\r\n"));
      let got = "";
      socket.on("data", d => (got += String(d)));
      socket.on("end", () => resolve(got));
      socket.on("error", reject);
    });
    expect(text).toMatch(/^HTTP\/1\.[01] 200 /);
    expect(text).toContain('"status":"idle"');
  });

  it("still serves the routes that want a token whatever host is asked for", async () => {
    const port = await boot();
    const res = await get(port, "/files", { host: "runner.example", ...bearer(await token()) });
    expect(res.status).toBe(200);
  });
});

describe("answers given without a token", () => {
  it("carry no header that lets a web page elsewhere read them", async () => {
    const port = await boot();
    for (const path of ["/healthz", "/", "/capabilities", "/nothing-here"]) {
      const res = await get(port, path, { origin: "https://evil.example" });
      expect(res.headers["access-control-allow-origin"], path).toBeUndefined();
    }
    const preflight = await get(port, "/capabilities", { origin: "https://evil.example", "access-control-request-method": "GET" }, "OPTIONS");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("while the routes that want a token can still be called from the dashboard's own page", async () => {
    const port = await boot();
    const origin = { origin: "https://dashboard.example" };
    const preflight = await get(
      port,
      "/files",
      { ...origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
      "OPTIONS",
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(String(preflight.headers["access-control-allow-headers"])).toContain("authorization");
    expect((await get(port, "/files", { ...origin, ...bearer(await token()) })).headers["access-control-allow-origin"]).toBe("*");
    // Without a token the answer is a no, which the page is still allowed to read as one.
    const refused = await get(port, "/files", origin);
    expect(refused.status).toBe(401);
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("a runner in a sandbox", () => {
  it("tells a caller with no token only that it is up", async () => {
    const port = await boot({ host: "0.0.0.0", sandbox: true });
    for (const path of ["/healthz", "/"]) {
      const res = await get(port, path, { host: "7420-sandbox.provider.example" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(ALIVE);
    }
  });

  it("tells the whole of it to a caller with a token for the thread", async () => {
    const port = await boot({ host: "0.0.0.0", sandbox: true });
    const full = async (t: string) => (await get(port, "/healthz", bearer(t))).body;
    expect(await full(await token())).toMatchObject({ ...ALIVE, status: "idle", agent: "claude-code" });
    expect(await full(await token({ scope: "runner" }))).toMatchObject({ status: "idle" });
    expect(await full(await token({ scope: "runner" }, await deriveAgentKey(SECRET)))).toMatchObject({ status: "idle" });
  });

  it.each([
    ["for another thread", () => token({ threadId: "another-thread-2" })],
    ["that has run out", () => token({ exp: Math.floor(Date.now() / 1000) - 5 })],
    ["signed with something else", () => token({}, "not-the-thread-secret-at-all-0000")],
    ["made for a phone", () => token({ scope: "phone", sub: "user-1" })],
    ["made for the relay", () => token({ scope: "relay" })],
    ["that isn't one", async () => "nonsense"],
  ])("tells a caller with a token %s only that it is up", async (_label, make) => {
    const port = await boot({ host: "0.0.0.0", sandbox: true });
    const res = await get(port, "/healthz", bearer(await make()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ALIVE);
  });
});
