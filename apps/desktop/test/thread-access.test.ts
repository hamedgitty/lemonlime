import { describe, expect, it } from "vitest";
import { Thread, type ThreadEvent } from "@lemonlime/protocol";
import { CloudApi, CloudError, tellsWhoseThreads } from "../src/lib/cloud.ts";
import { readStoredHistory } from "../src/lib/storedHistory.ts";
import { readOnly, sharingOf, signInRefusal, statusLabel, threadAccess } from "../src/lib/threadAccess.ts";
import { threadCardLines } from "../src/lib/threadCard.ts";
import { summarize, type ThreadEntry } from "../src/lib/threads.ts";

/** A cloud thread as an older control plane sends it: nothing about whose it is. */
const plain = {
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
const cloud = (o: { mine?: boolean; shared?: boolean } = {}): ThreadEntry => ({ mode: "cloud", thread: Thread.parse({ ...plain, ...o }) });
const local: ThreadEntry = {
  mode: "local",
  meta: {
    id: "local-0001",
    title: "Local work",
    agent: { kind: "claude-code" },
    repoPath: "/code/site",
    branch: "agent/local-0001",
    baseBranch: "main",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Extract<ThreadEntry, { mode: "local" }>["meta"],
};

const mine = cloud({ mine: true, shared: false });
const sharedByMe = cloud({ mine: true, shared: true });
const sharedWithMe = cloud({ mine: false, shared: true });
const someoneElses = cloud({ mine: false, shared: false });

describe("who may direct a thread", () => {
  it("lets the person who started a cloud thread take part and decide who else may", () => {
    expect(threadAccess(mine, { sharing: true })).toEqual({ takePart: true, canShare: true, shared: false });
    expect(threadAccess(sharedByMe, { sharing: true })).toEqual({ takePart: true, canShare: true, shared: true });
    expect(readOnly(mine)).toBe(false);
  });

  it("lets a workspace member take part in a thread shared with them, without the switch", () => {
    expect(threadAccess(sharedWithMe, { sharing: true })).toEqual({ takePart: true, canShare: false, shared: true });
    expect(readOnly(sharedWithMe)).toBe(false);
  });

  it("leaves someone else's thread that isn't shared to be read and nothing more", () => {
    expect(threadAccess(someoneElses, { sharing: true })).toEqual({ takePart: false, canShare: false, shared: false });
    expect(readOnly(someoneElses)).toBe(true);
  });

  it("changes nothing for a thread on this computer", () => {
    expect(threadAccess(local, { sharing: true })).toEqual({ takePart: true, canShare: false, shared: false });
    expect(readOnly(local)).toBe(false);
  });

  it("treats every thread from a control plane that doesn't say whose it is as your own, with nothing to share", () => {
    const old = cloud();
    expect(readOnly(old)).toBe(false);
    expect(threadAccess(old)).toEqual({ takePart: true, canShare: false, shared: false });
    expect(summarize(old, true).sharing).toBeUndefined();
  });
});

describe("how a thread's sharing is told", () => {
  it("is only worth saying when someone else is involved", () => {
    expect(sharingOf({ mine: true, shared: false })).toBeNull();
    expect(sharingOf({ mine: true, shared: true })).toBe("shared-by-you");
    expect(sharingOf({ mine: false, shared: true })).toBe("shared-with-you");
    expect(sharingOf({ mine: false, shared: false })).toBe("read-only");
  });

  it("goes on the sidebar row's summary for cloud threads, and never for local ones", () => {
    expect(summarize(someoneElses, true).sharing).toBe("read-only");
    expect(summarize(sharedWithMe, true).sharing).toBe("shared-with-you");
    expect(summarize(sharedByMe, true).sharing).toBe("shared-by-you");
    expect(summarize(mine, true).sharing).toBeUndefined();
    expect(summarize(local, true).sharing).toBeUndefined();
  });

  it("shows in the hover card who started it and whether it is shared", () => {
    const now = Date.parse("2026-01-01T00:05:00.000Z");
    const lines = (entry: ThreadEntry) => Object.fromEntries(threadCardLines(summarize(entry, true), { now }).map(l => [l.label, l.value]));
    expect(lines(someoneElses)).toMatchObject({ "Started by": "Someone else, read only", "Last activity": "Waiting for a reply, 5 min ago" });
    expect(lines(sharedWithMe)).toMatchObject({ "Started by": "Someone else, shared with you", "Last activity": "Waiting for you, 5 min ago" });
    expect(lines(sharedByMe)).toMatchObject({ Shared: "With this workspace" });
    expect(lines(mine)["Started by"]).toBeUndefined();
    expect(lines(mine).Shared).toBeUndefined();
  });

  it("never says a thread you can only read is waiting for you", () => {
    expect(statusLabel("idle")).toBe("Waiting for you");
    expect(statusLabel("idle", "shared-with-you")).toBe("Waiting for you");
    expect(statusLabel("idle", "read-only")).toBe("Waiting for a reply");
    expect(statusLabel("running", "read-only")).toBe(statusLabel("running"));
  });
});

describe("the control plane's side of sharing", () => {
  const respond = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("is known once a thread arrives that says whose it is", () => {
    expect(tellsWhoseThreads({ threads: [plain] })).toBe(false);
    expect(tellsWhoseThreads([plain])).toBe(false);
    expect(tellsWhoseThreads({ thread: plain, endpoint: null })).toBe(false);
    expect(tellsWhoseThreads(null)).toBe(false);
    expect(tellsWhoseThreads({ threads: [plain, { ...plain, mine: false }] })).toBe(true);
    expect(tellsWhoseThreads({ threads: [{ thread: { ...plain, mine: true }, endpoint: null }] })).toBe(true);
    expect(tellsWhoseThreads({ thread: { ...plain, mine: true, shared: false }, endpoint: null })).toBe(true);
  });

  it("offers no sharing against a control plane that never says whose a thread is", async () => {
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, respond({ threads: [plain] }));
    const [thread] = await api.listThreads();
    expect(api.canShareThreads).toBe(false);
    expect(threadAccess({ mode: "cloud", thread: thread! }, { sharing: api.canShareThreads }).canShare).toBe(false);
  });

  it("offers sharing to the starter once the control plane says whose its threads are", async () => {
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, respond({ threads: [{ ...plain, mine: true, shared: false }] }));
    expect(api.canShareThreads).toBe(false);
    const [thread] = await api.listThreads();
    expect(api.canShareThreads).toBe(true);
    expect(threadAccess({ mode: "cloud", thread: thread! }, { sharing: api.canShareThreads }).canShare).toBe(true);
  });

  it("switches sharing on and off through the route that renames a thread, sending nothing else", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ thread: { ...plain, mine: true, shared: true }, endpoint: null }), { status: 200 });
    });
    await api.shareThread("thread-0001", true);
    await api.shareThread("thread-0001", false);
    expect(calls).toEqual([
      { url: "http://cp.test/api/threads/thread-0001", method: "PATCH", body: JSON.stringify({ shared: true }) },
      { url: "http://cp.test/api/threads/thread-0001", method: "PATCH", body: JSON.stringify({ shared: false }) },
    ]);
  });

  it("passes on the control plane's words when someone who didn't start the thread tries to share it", async () => {
    const api = new CloudApi(
      { url: "http://cp.test", token: "t" },
      async () => new Response(JSON.stringify({ error: "forbidden", message: "Only the person who started this thread can share it." }), { status: 403 }),
    );
    const err = await api.shareThread("thread-0001", true).catch(e => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.message).toBe("Only the person who started this thread can share it.");
  });
});

describe("signing the agent in from a cloud thread", () => {
  it("stops with the control plane's reason when it refuses someone who didn't start the thread", () => {
    expect(signInRefusal(new CloudError("Only the person who started this thread can sign its agent in.", 403))).toBe(
      "Only the person who started this thread can sign its agent in.",
    );
  });

  it("goes ahead when the control plane has no such route or couldn't be reached", () => {
    expect(signInRefusal(new CloudError("Not found", 404))).toBeNull();
    expect(signInRefusal(new CloudError("Something broke", 500))).toBeNull();
    expect(signInRefusal(new TypeError("Failed to fetch"))).toBeNull();
    expect(signInRefusal("nope")).toBeNull();
  });
});

describe("reading a thread's stored history", () => {
  const event = (seq: number): ThreadEvent =>
    ({ type: "agent_message", text: `message ${seq}`, partial: false, threadId: "thread-0001", seq, at: "2026-01-01T00:00:00.000Z" }) as ThreadEvent;
  /** A control plane holding `total` events, handing them out `size` at a time. */
  const stored = (total: number, size: number) => {
    const asked: number[] = [];
    const history = async (_id: string, after = 0) => {
      asked.push(after);
      const events = Array.from({ length: Math.max(0, Math.min(size, total - after)) }, (_, i) => event(after + i + 1));
      return { events, more: after + events.length < total };
    };
    return { api: { history } as unknown as Pick<CloudApi, "history">, asked };
  };

  it("reads page after page from where the app already is, until there is no more", async () => {
    const { api, asked } = stored(7, 3);
    const seen: number[] = [];
    const last = await readStoredHistory(api, "thread-0001", 1, page => seen.push(...page.map(e => e.seq)));
    expect(seen).toEqual([2, 3, 4, 5, 6, 7]);
    expect(asked).toEqual([1, 4]);
    expect(last).toBe(7);
  });

  it("hands over nothing when there is nothing new", async () => {
    const { api } = stored(3, 3);
    const pages: ThreadEvent[][] = [];
    expect(await readStoredHistory(api, "thread-0001", 3, page => pages.push(page))).toBe(3);
    expect(pages).toEqual([]);
  });

  it("stops as soon as the thread is closed, dropping the page that was on its way", async () => {
    const { api, asked } = stored(9, 3);
    let pages = 0;
    await readStoredHistory(
      api,
      "thread-0001",
      0,
      () => pages++,
      () => pages >= 1,
    );
    expect(pages).toBe(1);
    expect(asked).toEqual([0]);
  });

  it("reads a bounded stretch at a time, so a very long thread can't hold the app up", async () => {
    const { api, asked } = stored(1000, 1);
    const last = await readStoredHistory(api, "thread-0001", 0, () => undefined);
    expect(asked.length).toBe(50);
    expect(last).toBe(50);
  });
});
