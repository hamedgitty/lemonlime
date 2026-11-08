import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { buildTimeline, type TimelineItem } from "../src/lib/timeline.ts";
import { editSendPlan, forkNote, forkTitle, rewindLanded, startEdit } from "../src/lib/messageActions.ts";

const threadId = "abc123-thread";
const at = "2026-01-01T00:00:00.000Z";
const events = (list: NewEvent[]): ThreadEvent[] => list.map((e, i) => ThreadEvent.parse({ ...e, threadId, at, seq: i + 1 }));
const source = { title: "Fix the sums", branch: "agent/abc", baseBranch: "main" };

const conversation = () =>
  buildTimeline(
    events([
      { type: "user_message", text: "Fix sum.js" },
      { type: "tool_call", callId: "c1", name: "Read", input: { file_path: "sum.js" } },
      { type: "agent_message", text: "Fixed it: the loop started at 1.", partial: false },
      { type: "file_diff", path: "sum.js", change: "modified", diff: "", truncated: false },
      { type: "user_message", text: "Now add tests" },
      { type: "agent_message", text: "Added tests.", partial: false },
    ]),
  );

describe("forking a thread", () => {
  it("carries the conversation up to the message, with files changed by then", () => {
    const items = conversation();
    const firstReply = items.find(i => i.kind === "agent")!;
    const note = forkNote(items, { key: firstReply.key }, source)!;
    expect(note).toContain("Fix the sums");
    expect(note).toContain("**User:**\n\nFix sum.js");
    expect(note).toContain("**Agent:**\n\nFixed it: the loop started at 1.");
    expect(note).not.toContain("Now add tests");
    // The diff came after this reply, so it isn't listed yet.
    expect(note).not.toContain("## Files the earlier thread had changed");
    expect(note).toContain("wait for what the user wants next");
    expect(note).toContain("start from main");
    expect(note).toContain("agent/abc");
  });

  it("from your own message, picks up from it, listing the files changed before", () => {
    const items = conversation();
    const second = items.filter(i => i.kind === "user")[1]!;
    const note = forkNote(items, { key: second.key }, source)!;
    expect(note).toContain("Now add tests");
    expect(note).toContain("- sum.js (modified)");
    expect(note).toContain("Pick up from the user's last message above.");
    expect(note).not.toContain("Added tests.");
  });

  it("quotes the part the user selected", () => {
    const items = conversation();
    const reply = items.find(i => i.kind === "agent")!;
    expect(forkNote(items, { key: reply.key, quote: "the loop\nstarted at 1" }, source)).toContain("> the loop\n> started at 1");
  });

  it("keeps the first message and the latest ones when the conversation is long", () => {
    const list: NewEvent[] = [];
    for (let i = 0; i < 40; i++) {
      list.push({ type: "user_message", text: `ask ${i} ${"x".repeat(900)}` });
      list.push({ type: "agent_message", text: `answer ${i} ${"y".repeat(900)}`, partial: false });
    }
    const items = buildTimeline(events(list));
    const note = forkNote(items, { key: items.at(-1)!.key }, source)!;
    expect(note.length).toBeLessThanOrEqual(16_001);
    expect(note).toContain("ask 0 ");
    expect(note).toContain("answer 39 ");
    expect(note).toMatch(/\(\d+ messages in between left out\)/);
    expect(note).not.toContain("ask 1 x");
  });

  it("returns null for a message that isn't there, and names the fork", () => {
    expect(forkNote(conversation(), { key: "nope" }, source)).toBeNull();
    expect(forkTitle("Fix the sums")).toBe("Fix the sums (fork)");
    expect(forkTitle("Fix the sums (fork)")).toBe("Fix the sums (fork)");
    expect(forkTitle("  ")).toBe("Thread (fork)");
  });
});

describe("editing a sent message", () => {
  const user = (over: Partial<Extract<TimelineItem, { kind: "user" }>> = {}): Extract<TimelineItem, { kind: "user" }> => ({
    kind: "user",
    key: "e5",
    seq: 5,
    at,
    text: "Now add tests",
    pending: false,
    ...over,
  });

  it("replaces history from the message when the thread can go back, else sends as new", () => {
    const draft = startEdit(user(), true)!;
    expect(draft).toMatchObject({ seq: 5, text: "Now add tests", replace: true, canReplace: true });
    expect(editSendPlan(draft, true)).toEqual({ rewindTo: 5 });
    expect(editSendPlan({ ...draft, replace: false }, true)).toEqual({ send: true });
    // Not connected: it can't go back, so it just sends.
    expect(editSendPlan(draft, false)).toEqual({ send: true });
    expect(editSendPlan(startEdit(user(), false), true)).toEqual({ send: true });
    expect(editSendPlan(null, true)).toEqual({ send: true });
  });

  it("can't edit a message that hasn't reached the runner", () => {
    expect(startEdit(user({ seq: null, pending: true }), true)).toBeNull();
  });

  it("waits for the runner to go back before the edited text is sent", () => {
    const before = events([
      { type: "user_message", text: "a" },
      { type: "agent_message", text: "b", partial: false },
    ]);
    expect(rewindLanded(before, 1, 2)).toBe(false);
    const after = [...before, ThreadEvent.parse({ type: "rewind", toSeq: 1, threadId, at, seq: 3 })];
    expect(rewindLanded(after, 1, 2)).toBe(true);
    // An older rewind to the same message doesn't count.
    expect(rewindLanded(after, 1, 3)).toBe(false);
  });
});
