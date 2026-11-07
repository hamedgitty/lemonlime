import { describe, expect, it } from "vitest";
import { CloudApi, CloudError, parseThreadList } from "../src/lib/cloud.ts";

const thread = {
  id: "thread-0001",
  title: "Fix tests",
  agent: { kind: "codex" },
  repo: { url: "https://example.com/r.git", baseBranch: "main" },
  branch: "agent/thread-0001",
  mode: "cloud",
  status: "idle",
  sandboxSize: "small",
  latestSeq: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parseThreadList", () => {
  it("accepts arrays, wrapped lists and endpoint items", () => {
    expect(parseThreadList([thread])).toHaveLength(1);
    expect(parseThreadList({ threads: [thread] })).toHaveLength(1);
    expect(parseThreadList({ threads: [{ thread, endpoint: null }, { nope: true }] })).toHaveLength(1);
  });
});

describe("CloudApi", () => {
  it("sends the bearer token", async () => {
    let auth = "";
    const api = new CloudApi({ url: "http://cp.test/", token: "tok" }, async (url, init) => {
      expect(url).toBe("http://cp.test/api/threads");
      auth = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ threads: [thread] }), { status: 200 });
    });
    expect(await api.listThreads()).toHaveLength(1);
    expect(auth).toBe("Bearer tok");
  });

  it("works in the chosen workspace, and lists workspaces without one", async () => {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify(url.includes("/api/workspaces") ? { workspaces: [{ id: "w1", name: "Me", personal: true, role: "owner" }] } : { threads: [] }),
        { status: 200 },
      );
    };
    const api = new CloudApi({ url: "http://cp.test", token: "tok", workspaceId: "team 1" }, fetcher);
    await api.listThreads();
    await api.history("thread-0001", 5).catch(() => undefined);
    expect(await api.listWorkspaces()).toEqual([{ id: "w1", name: "Me", personal: true, role: "owner" }]);
    expect(urls[0]).toBe("http://cp.test/api/threads?workspace=team%201");
    expect(urls[1]).toBe("http://cp.test/api/threads/thread-0001/events?after=5&workspace=team%201");
    expect(urls[2]).toBe("http://cp.test/api/workspaces");
  });

  it("turns a 402 into a policy denial", async () => {
    const api = new CloudApi(
      { url: "http://cp.test", token: "t" },
      respond(402, { error: "policy_denied", reason: "Not allowed right now.", actionUrl: "http://cp.test/help", actionLabel: "Details" }),
    );
    const err = await api.resumeThread("thread-0001").catch(e => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.status).toBe(402);
    expect(err.denial).toMatchObject({ reason: "Not allowed right now.", actionLabel: "Details" });
  });

  it("reports other errors with the server message", async () => {
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, respond(500, { message: "Database is down" }));
    await expect(api.getThread("thread-0001")).rejects.toThrow("Database is down");
  });
});
