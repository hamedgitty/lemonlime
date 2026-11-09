import { describe, expect, it } from "vitest";
import { ThreadEvent, type BranchInfo, type NewEvent } from "@lemonlime/protocol";
import { existingBranchProblem, filterBranches, pullRequestIn } from "../src/lib/branches.ts";
import { forkCommit, forkNote } from "../src/lib/messageActions.ts";
import { compareUrlWithDraft, conflictsPrompt } from "../src/lib/review.ts";
import { buildTimeline } from "../src/lib/timeline.ts";

const at = "2026-01-01T00:00:00.000Z";
const events = (list: NewEvent[]): ThreadEvent[] => list.map((e, i) => ThreadEvent.parse({ ...e, threadId: "abc123-thread", at, seq: i + 1 }));

const branches: BranchInfo[] = [
  { name: "main", remote: false, checkedOutAt: "/Users/me/app", date: "2026-01-03" },
  { name: "feature/login", remote: false, checkedOutAt: null, date: "2026-01-02" },
  { name: "release", remote: true, checkedOutAt: null, date: "2026-01-01" },
];

describe("choosing a branch on Home", () => {
  it("narrows the list as you type, and shows everything when you don't", () => {
    expect(filterBranches(branches, "").map(b => b.name)).toEqual(["main", "feature/login", "release"]);
    expect(filterBranches(branches, "login").map(b => b.name)).toEqual(["feature/login"]);
  });

  it("refuses to work on a branch checked out elsewhere, or one that isn't there", () => {
    expect(existingBranchProblem(branches, "main", "/Users/me/app/")).toMatch(/checked out in your project folder/);
    expect(existingBranchProblem(branches, "feature/login", "/Users/me/app")).toBeNull();
    expect(existingBranchProblem(branches, "release", "/Users/me/app")).toBeNull();
    expect(existingBranchProblem(branches, "nope", "/Users/me/app")).toMatch(/no branch named nope/);
    expect(existingBranchProblem(null, "anything", "/x")).toBeNull();
  });

  it("finds a pull request link in the message, or a message that is just #123", () => {
    expect(pullRequestIn("Please fix https://github.com/acme/app/pull/42.")).toBe("https://github.com/acme/app/pull/42");
    expect(pullRequestIn("#42")).toBe("#42");
    expect(pullRequestIn("fix #42 and #43")).toBeNull();
    expect(pullRequestIn("see https://github.com/acme/app/issues/42")).toBeNull();
  });
});

describe("forking keeps the code", () => {
  const list = events([
    { type: "user_message", text: "Fix sum.js", commit: "c0" },
    { type: "agent_message", text: "Fixed it.", partial: false },
    { type: "user_message", text: "Now add tests", commit: "c1" },
    { type: "agent_message", text: "Added tests.", partial: false },
  ]);

  it("starts from where the thread was at that message", () => {
    expect(forkCommit(list, 2)).toBe("c1");
    // A message you sent: from before its turn.
    expect(forkCommit(list, 3)).toBe("c1");
    expect(forkCommit(list, 1)).toBe("c0");
    // The latest reply: the branch as it is now.
    expect(forkCommit(list, 4)).toBeNull();
  });

  it("tells the new agent the earlier changes are already there", () => {
    const items = buildTimeline(list);
    const reply = items.find(i => i.kind === "agent")!;
    const withCode = forkNote(items, { key: reply.key }, { title: "Sums", branch: "agent/abc", baseBranch: "main", withCode: true })!;
    expect(withCode).toContain("so the changes made by then are already here");
    expect(forkNote(items, { key: reply.key }, { title: "Sums", branch: "agent/abc", baseBranch: "main" })).toContain("start from main");
  });
});

describe("pull requests and conflicts", () => {
  it("fills GitHub's compare page with the drafted title and description", () => {
    const url = new URL(compareUrlWithDraft("https://github.com/acme/app/compare/main...agent/x?expand=1", { title: "Fix it", body: "## Summary\n\nDone" }));
    expect(url.searchParams.get("expand")).toBe("1");
    expect(url.searchParams.get("title")).toBe("Fix it");
    expect(url.searchParams.get("body")).toBe("## Summary\n\nDone");
  });

  it("asks the agent to merge the base branch and resolve the listed conflicts", () => {
    const text = conflictsPrompt("origin/main", ["a.ts", "b.ts"]);
    expect(text).toMatch(/^Merge origin\/main into this branch/);
    expect(text).toContain("- a.ts\n- b.ts");
  });
});
