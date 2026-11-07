import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { appendEvents, buildTimeline, contiguousSeq, latestStatus } from "../src/lib/timeline.ts";

const threadId = "abc123-thread";
const at = "2026-01-01T00:00:00.000Z";
let seq = 0;
const ev = (e: NewEvent & { seq?: number }): ThreadEvent => ThreadEvent.parse({ threadId, at, ...e, seq: e.seq ?? ++seq });

describe("buildTimeline", () => {
  it("joins streaming agent chunks into one message", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "user_message", text: "hi" }),
      ev({ type: "agent_message", text: "Hel", partial: true }),
      ev({ type: "agent_message", text: "lo ", partial: true }),
      ev({ type: "agent_message", text: "there", partial: true }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "agent", text: "Hello there", streaming: true, seq: 2 });
  });

  it("replaces the chunks with the whole message when it arrives", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "agent_message", text: "Hel", partial: true }),
      ev({ type: "agent_message", text: "lo", partial: true }),
      ev({ type: "agent_message", text: "Hello!", partial: false }),
      ev({ type: "agent_message", text: "Second message", partial: false }),
    ]);
    expect(items.map(i => (i.kind === "agent" ? [i.text, i.streaming] : null))).toEqual([
      ["Hello!", false],
      ["Second message", false],
    ]);
  });

  it("starts a new message after a tool call and stops streaming", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "agent_message", text: "Let me look", partial: true }),
      ev({ type: "tool_call", callId: "c1", name: "Read", input: { file_path: "a.ts" } }),
      ev({ type: "agent_message", text: "Found it", partial: true }),
    ]);
    expect(items.map(i => i.kind)).toEqual(["agent", "tool", "agent"]);
    expect(items[0]).toMatchObject({ text: "Let me look", streaming: false });
    expect(items[2]).toMatchObject({ text: "Found it", streaming: true });
  });

  it("attaches tool results to their calls", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "ls" } }),
      ev({ type: "tool_call", callId: "c2", name: "Read", input: {} }),
      ev({ type: "tool_result", callId: "c1", output: "a\nb", isError: false }),
      ev({ type: "tool_result", callId: "zz", output: "orphan", isError: true }),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "tool", callId: "c1", result: { output: "a\nb", isError: false } });
    expect(items[1]).toMatchObject({ kind: "tool", callId: "c2", result: null });
    expect(items[2]).toMatchObject({ kind: "tool", callId: "zz", result: { isError: true } });
  });

  it("shows pending messages until the runner echoes them", () => {
    seq = 0;
    const pending = [
      { clientMsgId: "m1", text: "first", at },
      { clientMsgId: "m2", text: "second", at },
    ];
    const items = buildTimeline([ev({ type: "user_message", text: "first", clientMsgId: "m1" })], pending);
    expect(items.map(i => (i.kind === "user" ? [i.text, i.pending] : null))).toEqual([
      ["first", false],
      ["second", true],
    ]);
  });

  it("shows the runner's queue, including messages sent from another device", () => {
    seq = 0;
    const pending = [
      { clientMsgId: "q1", text: "mine, queued", at },
      { clientMsgId: "s1", text: "mine, still sending", at },
    ];
    const items = buildTimeline(
      [
        ev({ type: "user_message", text: "working on it", clientMsgId: "m1" }),
        ev({
          type: "queue_update",
          queue: [
            { clientMsgId: "q1", text: "mine, queued", queuedAt: at },
            { clientMsgId: "q2", text: "from my phone", queuedAt: at },
          ],
        }),
      ],
      pending,
    );
    expect(items.map(i => (i.kind === "user" ? [i.text, i.pending, i.queued ?? false] : null))).toEqual([
      ["working on it", false, false],
      // Their place in line, so they can be moved or sent now.
      ["mine, queued", true, { clientMsgId: "q1", index: 0, count: 2 }],
      ["from my phone", true, { clientMsgId: "q2", index: 1, count: 2 }],
      ["mine, still sending", true, false],
    ]);
    // Once a queued message starts it shows as a normal message, once.
    const later = buildTimeline(
      [
        ev({ type: "user_message", text: "working on it", clientMsgId: "m1" }),
        ev({ type: "queue_update", queue: [{ clientMsgId: "q2", text: "from my phone", queuedAt: at }] }),
        ev({ type: "user_message", text: "mine, queued", clientMsgId: "q1" }),
      ],
      pending,
    );
    expect(later.filter(i => i.kind === "user").map(i => (i.kind === "user" ? i.text : ""))).toEqual([
      "working on it",
      "mine, queued",
      "from my phone",
      "mine, still sending",
    ]);
  });

  it("keeps a streaming message whole when the queue changes mid-stream", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "agent_message", text: "Work", partial: true }),
      ev({ type: "queue_update", queue: [] }),
      ev({ type: "agent_message", text: "ing", partial: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "agent", text: "Working", streaming: true });
  });

  it("shows an approval request as waiting until it's decided", () => {
    seq = 0;
    const request = ev({ type: "approval_request", requestId: "r1", tool: "Bash", input: { command: "npm test" }, summary: "npm test" });
    expect(buildTimeline([request])[0]).toMatchObject({ kind: "approval", state: "waiting", summary: "npm test" });
    const decided = buildTimeline([request, ev({ type: "approval_result", requestId: "r1", decision: "deny", by: "timeout" })]);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ kind: "approval", state: "denied", by: "timeout" });
  });

  it("ignores duplicate and stale seqs", () => {
    seq = 0;
    const a = ev({ type: "user_message", text: "one" });
    const items = buildTimeline([a, a, ev({ type: "error", message: "boom", fatal: true })]);
    expect(items.map(i => i.kind)).toEqual(["user", "error"]);
  });
});

describe("appendEvents", () => {
  it("appends in order and drops duplicates", () => {
    seq = 0;
    const e1 = ev({ type: "user_message", text: "1" });
    const e2 = ev({ type: "user_message", text: "2" });
    const e3 = ev({ type: "user_message", text: "3" });
    const h = appendEvents([e1], [e1, e3, e2]);
    expect(h.map(e => e.seq)).toEqual([1, 2, 3]);
    const same = appendEvents(h, [e2]);
    expect(same).toBe(h);
  });
});

describe("contiguousSeq / latestStatus", () => {
  it("finds the last gap-free seq", () => {
    seq = 0;
    const list = [1, 2, 3, 5].map(n => ev({ type: "user_message", text: String(n), seq: n }));
    expect(contiguousSeq(list)).toBe(3);
    expect(contiguousSeq([])).toBe(0);
  });

  it("reads the latest status change", () => {
    seq = 0;
    expect(latestStatus([ev({ type: "status_change", from: "idle", to: "running" }), ev({ type: "status_change", from: "running", to: "idle" })])).toBe("idle");
  });
});
