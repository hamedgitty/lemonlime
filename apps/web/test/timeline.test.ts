import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@lemonlime/protocol";
import { addEvent, buildTimeline, diffLines, isLongReport, startsTurn } from "../src/lib/timeline.ts";

const T = "thread-aaaaaa";
let seq = 0;
const at = "2026-01-01T00:00:00.000Z";
const ev = <E extends Record<string, unknown>>(e: E) => ({ threadId: T, seq: ++seq, at, ...e }) as unknown as ThreadEvent;

describe("buildTimeline", () => {
  it("joins streaming chunks and replaces them with the whole message", () => {
    seq = 0;
    const events = [ev({ type: "agent_message", text: "Hel", partial: true }), ev({ type: "agent_message", text: "lo", partial: true })];
    expect(buildTimeline(events)).toMatchObject([{ kind: "agent", text: "Hello", streaming: true }]);
    events.push(ev({ type: "agent_message", text: "Hello!", partial: false }));
    expect(buildTimeline(events)).toMatchObject([{ kind: "agent", text: "Hello!", streaming: false }]);
  });

  it("pairs tool results with their calls", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "ls" } }),
      ev({ type: "tool_result", callId: "c1", output: "a\nb", isError: false }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", call: { name: "Bash" }, result: { output: "a\nb" } });
  });

  it("hides optimistic messages once the runner echoes them", () => {
    seq = 0;
    const pending = [{ clientMsgId: "m1", text: "hi", at }];
    expect(buildTimeline([], pending)).toMatchObject([{ kind: "user", pending: true }]);
    const echoed = buildTimeline([ev({ type: "user_message", text: "hi", clientMsgId: "m1" })], pending);
    expect(echoed).toHaveLength(1);
    expect(echoed[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(echoed[0]).not.toHaveProperty("pending");
  });
});

describe("addEvent", () => {
  it("shows queued messages without breaking a message that is still streaming", () => {
    seq = 0;
    const events = [
      ev({ type: "agent_message", text: "Work", partial: true }),
      ev({ type: "queue_update", queue: [{ clientMsgId: "q1", text: "next please", queuedAt: at }] }),
      ev({ type: "agent_message", text: "ing", partial: true }),
    ];
    const items = buildTimeline(events, [{ clientMsgId: "q1", text: "next please", at }]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "agent", text: "Working", streaming: true });
    expect(items[1]).toMatchObject({ kind: "user", text: "next please", pending: true, queued: true });
  });

  it("keeps events sorted and drops duplicates", () => {
    seq = 0;
    const [a, b, c] = [
      ev({ type: "agent_message", text: "a", partial: false }),
      ev({ type: "agent_message", text: "b", partial: false }),
      ev({ type: "agent_message", text: "c", partial: false }),
    ];
    let list = addEvent([], a!);
    list = addEvent(list, c!);
    list = addEvent(list, b!);
    list = addEvent(list, b!);
    expect(list.map(e => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("diffLines", () => {
  it("classifies unified diff lines", () => {
    const kinds = diffLines("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n").map(l => l.kind);
    expect(kinds).toEqual(["meta", "meta", "hunk", "context", "del", "add"]);
  });

  it("leaves out what a rewind set aside, and says where it happened", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "user_message", text: "one" }),
      ev({ type: "agent_message", text: "did one", partial: false }),
      ev({ type: "user_message", text: "two" }),
      ev({ type: "agent_message", text: "did two", partial: false }),
      ev({ type: "rewind", toSeq: 3, restoredTo: "abc123" }),
      ev({ type: "user_message", text: "two, again" }),
    ]);
    expect(items.map(i => (i.kind === "user" || i.kind === "agent" ? i.text : i.kind))).toEqual(["one", "did one", "notice", "two, again"]);
  });
});

describe("buildTimeline: plans and questions", () => {
  it("keeps the latest plan open until a message follows, and pairs questions with answers", () => {
    seq = 0;
    const events = [
      ev({ type: "agent_message", text: "Look", partial: true }),
      ev({ type: "todo_snapshot", items: [{ text: "A", status: "in_progress" }] }),
      ev({ type: "agent_message", text: "ing", partial: true }),
      ev({ type: "question_request", requestId: "q1", questions: [{ question: "Which?", options: [{ label: "A" }], multiSelect: false }] }),
      ev({ type: "question_result", requestId: "q1", answers: [["A"]], by: "user" }),
      ev({ type: "plan_proposal", plan: "# Plan" }),
    ];
    const items = buildTimeline(events);
    expect(items.map(i => i.kind)).toEqual(["agent", "question", "plan"]);
    expect(items[0]).toMatchObject({ text: "Looking" });
    expect(items[1]).toMatchObject({ result: { answers: [["A"]] } });
    expect(items[2]).toMatchObject({ open: true });
    events.push(ev({ type: "user_message", text: "go" }));
    expect(buildTimeline(events)[2]).toMatchObject({ kind: "plan", open: false });
  });
});

describe("buildTimeline: reasoning and turn times", () => {
  const timed = (s: number, e: Record<string, unknown>) =>
    ({ threadId: T, seq: ++seq, at: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString(), ...e }) as unknown as ThreadEvent;

  it("streams reasoning into one row timed from the event before it", () => {
    seq = 0;
    const items = buildTimeline([
      timed(0, { type: "user_message", text: "go" }),
      timed(2, { type: "agent_reasoning", text: "Look ", partial: true }),
      timed(5, { type: "agent_reasoning", text: "around", partial: true }),
      timed(9, { type: "agent_reasoning", text: "Look around.", partial: false }),
      timed(10, { type: "agent_message", text: "Done", partial: false }),
    ]);
    expect(items.map(i => i.kind)).toEqual(["user", "reasoning", "agent"]);
    expect(items[1]).toMatchObject({ text: "Look around.", streaming: false, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:09.000Z" });
  });

  it("says how long a turn took on the status change that ended it", () => {
    seq = 0;
    const items = buildTimeline([
      timed(0, { type: "user_message", text: "go" }),
      timed(0, { type: "status_change", from: "idle", to: "running" }),
      timed(95, { type: "status_change", from: "running", to: "idle" }),
    ]);
    // The turn starting has no row of its own; the one that ended it says how long it took.
    expect(items.map(i => i.kind)).toEqual(["user", "status"]);
    expect(items[1]).toMatchObject({ kind: "status", workedMs: 95_000 });
  });

  it("stops showing a message as streaming once something else arrives", () => {
    seq = 0;
    const items = buildTimeline([ev({ type: "agent_message", text: "Hel", partial: true }), ev({ type: "tool_call", callId: "c", name: "Read", input: {} })]);
    expect(items[0]).toMatchObject({ kind: "agent", streaming: false });
  });
});

describe("usage limits in the dashboard", () => {
  it("shows a limit row, with the runner's wait folded in, until the thread carries on", () => {
    seq = 0;
    const hit = ev({
      type: "limit_hit",
      agent: "codex",
      resetAt: "2026-01-01T03:00:00.000Z",
      message: "You've hit your usage limit.",
      accounts: [],
      agents: [],
    });
    const waiting = ev({ type: "notice", code: "retry_scheduled", message: "…", untilAt: "2026-01-01T03:01:00.000Z" });
    let items = buildTimeline([hit, waiting]);
    expect(items).toMatchObject([{ kind: "limit", open: true, waiting: true, waitingUntil: "2026-01-01T03:01:00.000Z" }]);
    const moved = ev({ type: "agent_switch", from: { agent: "codex" }, to: { agent: "claude-code", model: "opus" }, carried: "handoff", auto: false });
    items = buildTimeline([hit, waiting, moved, ev({ type: "status_change", from: "idle", to: "running" })]);
    expect(items[0]).toMatchObject({ kind: "limit", open: false, waiting: false });
    expect(items[1]).toMatchObject({ kind: "switch", event: { to: { agent: "claude-code" } } });
  });
});

describe("messages nobody typed", () => {
  it("shows a subagent's report and the runner's own messages apart from what people wrote", () => {
    seq = 0;
    const items = buildTimeline([
      ev({ type: "user_message", text: "Fix the build", clientMsgId: "m1" }),
      ev({ type: "user_message", text: "The tests pass now.", from: "subagent" }),
      ev({ type: "user_message", text: "Carry on from where you stopped.", from: "runner" }),
    ]);
    expect(items).toMatchObject([
      { kind: "user", text: "Fix the build" },
      { kind: "auto", from: "subagent", text: "The tests pass now." },
      { kind: "auto", from: "runner", text: "Carry on from where you stopped." },
    ]);
    expect(items.map(startsTurn)).toEqual([true, true, true]);
  });

  it("keeps showing messages from a runner that doesn't say who sent them as a person's", () => {
    seq = 0;
    const items = buildTimeline([ev({ type: "user_message", text: "A report, from an older runner" })]);
    expect(items).toMatchObject([{ kind: "user", text: "A report, from an older runner" }]);
    expect(items[0]).not.toHaveProperty("from");
  });

  it("closes an open plan like any other message that follows it", () => {
    seq = 0;
    const items = buildTimeline([ev({ type: "plan_proposal", plan: "1. Do it" }), ev({ type: "user_message", text: "Done.", from: "subagent" })]);
    expect(items).toMatchObject([{ kind: "plan", open: false }, { kind: "auto" }]);
  });

  it("folds a long report and shows a short one whole", () => {
    expect(isLongReport("All good.")).toBe(false);
    expect(isLongReport("x".repeat(601))).toBe(true);
    expect(isLongReport(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"))).toBe(true);
  });
});
