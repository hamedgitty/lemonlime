import { afterEach, describe, expect, it } from "vitest";
import { branchForThread, signToken, type Thread, deriveAgentKey } from "@lemonlime/protocol";
import { gitCredential, Relay, startServer, ThreadRunner, type AgentAdapter } from "../src/index.ts";

const SECRET = "thread-secret-for-relay-tests-0123";
const AGENT_KEY = await deriveAgentKey(SECRET);
const THREAD = "relay-thread-1";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// Runner-scope requests here come from the agent's own git helper, signed with the agent key.
const token = async (scope: "runner" | "relay" | "client", threadId = THREAD) =>
  signToken({ threadId, scope, exp: Math.floor(Date.now() / 1000) + 60 }, scope === "runner" ? await deriveAgentKey(SECRET) : SECRET);

async function serve(relay: Relay | undefined) {
  const idle: AgentAdapter = { kind: "codex", createSession: () => ({ runTurn: async () => {}, saveState: () => ({}), dispose: async () => {} }) };
  const now = new Date().toISOString();
  const thread: Thread = {
    id: THREAD,
    title: "",
    agent: { kind: "codex" },
    repo: { url: "x", baseBranch: "main" },
    branch: branchForThread(THREAD),
    mode: "cloud",
    status: "idle",
    sandboxSize: "small",
    latestSeq: 0,
    mine: true,
    shared: false,
    createdAt: now,
    updatedAt: now,
  };
  const runner = new ThreadRunner({ thread, workdir: "/tmp", dataDir: null, adapter: idle, session: { autonomy: "full" }, git: false, bundledSkills: false });
  await runner.init();
  const server = await startServer(runner, { host: "127.0.0.1", port: 0, threadSecret: SECRET, version: "t", ...(relay ? { relay } : {}) });
  cleanups.push(
    () => runner.close(),
    () => server.close(),
  );
  return `http://127.0.0.1:${server.port}`;
}

describe("Relay queue", () => {
  it("hands each call out once, matches answers by id, and offers unanswered calls again", async () => {
    let now = 1_000_000;
    const relay = new Relay(() => now);
    const answered = relay.request({ method: "POST", path: "/api/runner/heartbeat", authorization: "Bearer t", body: { a: 1 } });
    const [call] = relay.take();
    expect(call).toMatchObject({ method: "POST", path: "/api/runner/heartbeat", body: { a: 1 } });
    expect(relay.take()).toEqual([]);
    now += 91_000; // the collector never answered
    expect(relay.take().map(c => c.id)).toEqual([call!.id]);
    expect(
      relay.answer([
        { id: "unknown", status: 200, body: {} },
        { id: call!.id, status: 200, body: { ok: true } },
      ]),
    ).toBe(1);
    await expect(answered).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(relay.size).toBe(0);
  });

  it("gives up on a call nobody collects", async () => {
    const relay = new Relay();
    await expect(relay.request({ method: "GET", path: "/api/runner/inbox?threadId=x", authorization: "Bearer t" }, 20)).rejects.toThrow("didn't collect");
    expect(relay.size).toBe(0);
  });
});

describe("runner /relay", () => {
  it("is only there in relay mode", async () => {
    const base = await serve(undefined);
    expect((await fetch(`${base}/relay`, { headers: { authorization: `Bearer ${await token("relay")}` } })).status).toBe(404);
  });

  it("lets the control plane collect and answer, with a relay token for this thread only", async () => {
    const relay = new Relay();
    const base = await serve(relay);
    const waiting = relay.request({ method: "POST", path: "/api/runner/heartbeat", authorization: "Bearer r", body: { threadId: THREAD } });
    for (const t of [await token("runner"), await token("client"), await token("relay", "other-thread-2")])
      expect((await fetch(`${base}/relay`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(401);
    const auth = { authorization: `Bearer ${await token("relay")}` };
    const polled = (await (await fetch(`${base}/relay`, { headers: auth })).json()) as { requests: { id: string; path: string }[] };
    expect(polled.requests.map(r => r.path)).toEqual(["/api/runner/heartbeat"]);
    const sent = await fetch(`${base}/relay`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ id: polled.requests[0]!.id, status: 200, body: { action: "none", pendingMessages: 0 } }] }),
    });
    expect(await sent.json()).toEqual({ matched: 1 });
    await expect(waiting).resolves.toEqual({ status: 200, body: { action: "none", pendingMessages: 0 } });
  });

  it("relays the git helper's token request, and nothing else, from inside the sandbox", async () => {
    const relay = new Relay();
    const base = await serve(relay);
    const local = (path: string) =>
      token("runner").then(t =>
        fetch(`${base}/relay/local`, {
          method: "POST",
          headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      );
    expect((await local("/api/runner/heartbeat")).status).toBe(400);
    const pending = local(`/api/runner/git-credentials?threadId=${THREAD}&host=github.com`);
    // The control plane collects it and answers with a token.
    let calls: ReturnType<Relay["take"]> = [];
    for (let i = 0; i < 50 && calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
      calls = relay.take();
    }
    expect(calls.map(c => c.path)).toEqual([`/api/runner/git-credentials?threadId=${THREAD}&host=github.com`]);
    relay.answer([{ id: calls[0]!.id, status: 200, body: { username: "x-access-token", password: "ghs_fresh" } }]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "x-access-token", password: "ghs_fresh" });
  });
});

describe("git credential helper in relay mode", () => {
  const input = "protocol=https\nhost=github.com\npath=you/app.git\n\n";
  const base = { LEMONLIME_THREAD_ID: THREAD, LEMONLIME_AGENT_KEY: AGENT_KEY, LEMONLIME_CONTROL_PLANE_URL: "http://unreachable.invalid" };

  it("uses the token the sandbox started with, for its host, while it has time left", async () => {
    const later = new Date(Date.now() + 50 * 60_000).toISOString();
    const env = { ...base, LEMONLIME_GIT_TOKEN: "ghs_start", LEMONLIME_GIT_TOKEN_EXPIRES: later, LEMONLIME_GIT_HOST: "github.com" };
    expect(await gitCredential("get", input, env)).toBe("username=x-access-token\npassword=ghs_start\n");
    // Not for another host.
    expect(await gitCredential("get", "protocol=https\nhost=evil.example\n\n", env)).toBe("");
  });

  it("asks through the runner once the starting token is nearly spent", async () => {
    const relay = new Relay();
    const runnerUrl = await serve(relay);
    const soon = new Date(Date.now() + 60_000).toISOString();
    const env = {
      ...base,
      LEMONLIME_GIT_TOKEN: "ghs_old",
      LEMONLIME_GIT_TOKEN_EXPIRES: soon,
      LEMONLIME_GIT_HOST: "github.com",
      LEMONLIME_RELAY: "1",
      LEMONLIME_RUNNER_URL: runnerUrl,
    };
    const asked = gitCredential("get", input, env);
    let calls: ReturnType<Relay["take"]> = [];
    for (let i = 0; i < 100 && calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
      calls = relay.take();
    }
    expect(calls[0]!.path).toBe(`/api/runner/git-credentials?threadId=${THREAD}&host=github.com`);
    relay.answer([{ id: calls[0]!.id, status: 200, body: { username: "x-access-token", password: "ghs_new" } }]);
    expect(await asked).toBe("username=x-access-token\npassword=ghs_new\n");
  });
});
