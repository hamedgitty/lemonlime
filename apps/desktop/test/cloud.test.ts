import { describe, expect, it } from "vitest";
import { CloudApi, CloudError, parseThreadList, planSkillSync, skillsUnsynced } from "../src/lib/cloud.ts";

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

  it("renames threads and opens pull requests through the control plane", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (url.endsWith("/pull-request")) return new Response(JSON.stringify({ url: "https://github.com/a/b/pull/3", created: true }), { status: 200 });
      return new Response(JSON.stringify({ thread, endpoint: null, pullRequestUrl: "https://github.com/a/b/pull/3" }), { status: 200 });
    });
    await api.renameThread("thread-0001", "New name");
    expect(calls[0]).toEqual({ url: "http://cp.test/api/threads/thread-0001", method: "PATCH", body: JSON.stringify({ title: "New name" }) });
    expect(await api.openPullRequest("thread-0001")).toEqual({ url: "https://github.com/a/b/pull/3", created: true });
    expect(calls[1]!.method).toBe("POST");
    expect(await api.pullRequestUrl("thread-0001")).toBe("https://github.com/a/b/pull/3");
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

describe("syncing skills to the cloud", () => {
  it("sends this computer's picked skills and keeps the ones another computer added", () => {
    expect(planSkillSync(["a", "c"], ["a", "b"], ["a", "c", "d"])).toEqual({ send: ["a"], keep: ["c"], drop: ["d"] });
  });

  it("drops a skill from another computer only when it is switched off", () => {
    expect(planSkillSync(["a", "c", "d"], ["a"], ["c", "d"]).drop).toEqual([]);
    expect(planSkillSync(["a"], ["a"], ["c", "d"])).toEqual({ send: ["a"], keep: [], drop: ["c", "d"] });
  });

  it("knows when the picked skills differ from the cloud's", () => {
    expect(skillsUnsynced(["a", "c"], ["a", "b"], ["a", "c"])).toBe(false);
    expect(skillsUnsynced(["a", "b", "c"], ["a", "b"], ["a", "c"])).toBe(true);
    expect(skillsUnsynced(["a"], ["a", "b"], ["a", "c"])).toBe(true);
    expect(skillsUnsynced([], [], [])).toBe(false);
  });

  it("reads the cloud's skills with their files", async () => {
    let seen = "";
    const skills = [{ name: "tidy", files: { "SKILL.md": "# Tidy" } }];
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, async (url, init) => {
      seen = `${init?.method ?? "GET"} ${url}`;
      return new Response(JSON.stringify({ skills }), { status: 200 });
    });
    expect(await api.workspaceSkills()).toEqual(skills);
    expect(seen).toBe("GET http://cp.test/api/workspace/skills");
    expect(await new CloudApi({ url: "http://cp.test", token: "t" }, respond(200, {})).workspaceSkills()).toEqual([]);
  });
});
