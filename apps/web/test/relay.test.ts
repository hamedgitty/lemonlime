import { describe, expect, it } from "vitest";
import { verifyToken } from "@lemonlime/protocol";
import { relayEnabled, relayRunnerCalls } from "../src/lib/relay.ts";
import { buildRunnerLaunch } from "../src/lib/runner-command.ts";
import { createThread } from "../src/lib/threads.ts";
import { threadSecret } from "../src/lib/tokens.ts";
import { addUser, createTestApp, TEST_ENV } from "./helpers.ts";

const req = {
  agent: { kind: "codex" as const },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  mode: "cloud" as const,
  sandboxSize: "small" as const,
};

describe("relay mode launch", () => {
  it("starts the runner with --relay and a first repo token, kept out of history", () => {
    const launch = buildRunnerLaunch({
      threadId: "abc123-thread",
      agent: { kind: "codex" },
      repo: req.repo,
      controlPlaneUrl: "https://control.example.com",
      threadSecret: "thread-secret-0123456789abcdef",
      relay: true,
      gitToken: { token: "ghs_start", expiresAt: "2026-11-08T00:00:00.000Z", host: "github.com" },
    });
    expect(launch.command).toMatch(/--control-plane https:\/\/control\.example\.com --relay$/);
    expect(launch.env).toMatchObject({
      LEMONLIME_GIT_TOKEN: "ghs_start",
      LEMONLIME_GIT_TOKEN_EXPIRES: "2026-11-08T00:00:00.000Z",
      LEMONLIME_GIT_HOST: "github.com",
    });
    expect(launch.env.LEMONLIME_REDACT_ENV).toBe("LEMONLIME_GIT_TOKEN");
  });

  it("is off unless asked for", () => {
    expect(relayEnabled({})).toBe(false);
    expect(relayEnabled({ LEMONLIME_RUNNER_RELAY: "true" })).toBe(true);
  });
});

describe("relayRunnerCalls", () => {
  it("collects a runner's calls, makes them here and hands back the answers", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    const thread = await createThread(ctx, alice.userId, alice.workspaceId, req);
    const secret = await threadSecret(TEST_ENV.LEMONLIME_TOKEN_SECRET, thread.thread.id);

    const polls: string[] = [];
    const answered: unknown[] = [];
    let queue = [{ id: "c1", method: "POST", path: "/api/runner/heartbeat", authorization: "Bearer runner-token", body: { threadId: thread.thread.id } }];
    const fakeRunner = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const auth = await verifyToken((headers.get("authorization") ?? "").replace("Bearer ", ""), secret);
      expect(auth).toMatchObject({ ok: true, claims: { scope: "relay", threadId: thread.thread.id } });
      expect(headers.get("x-daytona-skip-preview-warning")).toBe("true");
      if ((init?.method ?? "GET") === "GET") {
        polls.push(url);
        const out = queue;
        queue = [];
        return Response.json({ requests: out });
      }
      answered.push(JSON.parse(String(init!.body)));
      return Response.json({ matched: 1 });
    }) as typeof fetch;
    const dispatched: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
    const dispatch = async (r: Request) => {
      dispatched.push({ url: r.url, method: r.method, auth: r.headers.get("authorization"), body: await r.json() });
      return Response.json({ action: "none", pendingMessages: 0 });
    };

    const result = await relayRunnerCalls(ctx, dispatch, { fetch: fakeRunner, sleep: async () => {} });
    expect(result).toEqual({ threads: 1, calls: 1, errors: [] });
    expect(polls[0]).toMatch(/\/relay$/);
    expect(dispatched).toEqual([
      { url: "http://localhost:3000/api/runner/heartbeat", method: "POST", auth: "Bearer runner-token", body: { threadId: thread.thread.id } },
    ]);
    expect(answered).toEqual([{ answers: [{ id: "c1", status: 200, body: { action: "none", pendingMessages: 0 } }] }]);
  });

  it("carries on past a runner it can't reach", async () => {
    const { ctx, db } = await createTestApp();
    const alice = await addUser(db, "alice@example.com");
    await createThread(ctx, alice.userId, alice.workspaceId, req);
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const result = await relayRunnerCalls(ctx, async () => new Response("{}"), { fetch: down, sleep: async () => {} });
    expect(result.threads).toBe(1);
    expect(result.errors[0]!.error).toContain("ECONNREFUSED");
  });
});
