import { describe, expect, it } from "vitest";
import { getStartedItems, showGetStarted, type GetStartedFacts } from "../src/lib/getStarted.ts";
import { addToInbox, automationRunItems, INBOX_LIMIT, markAllRead, markThreadRead, unreadCount, type Inbox } from "../src/lib/inbox.ts";

const fresh: GetStartedFacts = { agentReady: false, projects: 0, threads: 0, cloudThreads: 0, cloudConnected: false, githubLinked: null, dismissed: false };

describe("get started checklist", () => {
  it("ticks each step from what's true", () => {
    const done = (f: GetStartedFacts) =>
      getStartedItems(f)
        .filter(i => i.done)
        .map(i => i.id);
    expect(done(fresh)).toEqual([]);
    expect(done({ ...fresh, agentReady: true, projects: 2, threads: 1 })).toEqual(["agent", "project", "thread"]);
    expect(done({ ...fresh, cloudConnected: true, cloudThreads: 1, threads: 1, githubLinked: 1 })).toEqual(["thread", "cloud", "github"]);
  });

  it("only offers GitHub where the server can link it", () => {
    expect(getStartedItems(fresh).map(i => i.id)).toContain("github");
    expect(getStartedItems({ ...fresh, cloudConnected: true, githubLinked: null }).map(i => i.id)).not.toContain("github");
    expect(getStartedItems({ ...fresh, cloudConnected: true, githubLinked: 0 }).map(i => i.id)).toContain("github");
  });

  it("shows for new users until done or put away", () => {
    expect(showGetStarted(fresh)).toBe(true);
    expect(showGetStarted({ ...fresh, dismissed: true })).toBe(false);
    expect(showGetStarted({ ...fresh, threads: 25 })).toBe(false);
    const all = { agentReady: true, projects: 1, threads: 2, cloudThreads: 1, cloudConnected: true, githubLinked: 1, dismissed: false };
    expect(showGetStarted(all)).toBe(false);
    expect(showGetStarted({ ...all, githubLinked: null })).toBe(false);
  });
});

describe("notification centre", () => {
  const empty: Inbox = { items: [], since: "2026-11-01T00:00:00.000Z" };
  const item = (id: string, at: string, threadId?: string) => ({
    id,
    kind: "finished" as const,
    title: id,
    at,
    ...(threadId ? { thread: { mode: "local" as const, id: threadId } } : {}),
  });

  it("keeps the newest, once each, up to a limit", () => {
    let inbox = addToInbox(empty, item("a", "2026-11-02T00:00:00.000Z"));
    inbox = addToInbox(inbox, item("b", "2026-11-03T00:00:00.000Z"));
    inbox = addToInbox(inbox, item("a", "2026-11-04T00:00:00.000Z"));
    expect(inbox.items.map(i => i.id)).toEqual(["b", "a"]);
    for (let i = 0; i < INBOX_LIMIT + 10; i++) inbox = addToInbox(inbox, item(`n${i}`, new Date(Date.UTC(2026, 10, 5, 0, i)).toISOString()));
    expect(inbox.items).toHaveLength(INBOX_LIMIT);
    expect(inbox.items[0]!.id).toBe(`n${INBOX_LIMIT + 9}`);
  });

  it("counts unread, and marks all or one thread's read", () => {
    let inbox = addToInbox(empty, item("a", "2026-11-02T00:00:00.000Z", "t1"));
    inbox = addToInbox(inbox, item("b", "2026-11-03T00:00:00.000Z", "t2"));
    expect(unreadCount(inbox)).toBe(2);
    inbox = markThreadRead(inbox, "t1");
    expect(unreadCount(inbox)).toBe(1);
    expect(markAllRead(inbox).items.every(i => i.read)).toBe(true);
  });

  it("lists automation runs since the list began, once they're done", () => {
    const runs = automationRunItems(
      [
        {
          id: "a1",
          name: "Nightly bump",
          recentRuns: [
            {
              id: "r1",
              status: "started",
              outcome: "finished",
              ranAt: "2026-11-02T03:00:00.000Z",
              threadId: "t9",
              detail: null,
              summary: "Bumped 3 packages.",
            },
            { id: "r2", status: "skipped", outcome: "skipped", ranAt: "2026-11-03T03:00:00.000Z", threadId: "t10", detail: "Nothing to do.", summary: null },
            { id: "r3", status: "started", outcome: "started", ranAt: "2026-11-04T03:00:00.000Z", threadId: "t11", detail: null },
            { id: "r0", status: "started", outcome: "finished", ranAt: "2026-10-30T03:00:00.000Z", threadId: "t8", detail: null },
          ],
        },
      ],
      empty.since,
    );
    expect(runs.map(r => [r.id, r.kind])).toEqual([
      ["run:r1:automation-ran", "automation-ran"],
      ["run:r2:automation-skipped", "automation-skipped"],
    ]);
    expect(runs[0]).toMatchObject({ detail: "Bumped 3 packages.", thread: { mode: "cloud", id: "t9" } });
    expect(runs[1]).not.toHaveProperty("thread");
  });
});
