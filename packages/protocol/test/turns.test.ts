import { describe, expect, it } from "vitest";
import { elapsedMs, formatDuration, ThreadEvent, turnSpans, type NewEvent } from "../src/index.ts";

/** Events one per `[seconds after 10:00, event]`, numbered from 1. */
const timed = (events: [number, NewEvent][]): ThreadEvent[] =>
  events.map(([s, e], i) => ThreadEvent.parse({ ...e, threadId: "thread-abc123", seq: i + 1, at: new Date(Date.UTC(2026, 10, 8, 10, 0, s)).toISOString() }));

describe("turn durations", () => {
  it("runs from the user's message to the agent going idle", () => {
    const spans = turnSpans(
      timed([
        [0, { type: "user_message", text: "go" }],
        [0, { type: "status_change", from: "idle", to: "running" }],
        [30, { type: "agent_message", text: "done" }],
        [72, { type: "status_change", from: "running", to: "idle" }],
        [100, { type: "user_message", text: "again" }],
        [100, { type: "status_change", from: "idle", to: "running" }],
      ]),
    );
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ userSeq: 1, endSeq: 4 });
    expect(formatDuration(elapsedMs(spans[0]!.startAt, spans[0]!.endAt!)!)).toBe("1m 12s");
    // Still working: no end yet.
    expect(spans[1]).toMatchObject({ userSeq: 5, endAt: null, endSeq: null });
  });

  it("carries a turn on through a retry and ignores later status changes that aren't the agent stopping", () => {
    const [span] = turnSpans(
      timed([
        [0, { type: "user_message", text: "go" }],
        [0, { type: "status_change", from: "idle", to: "running" }],
        [5, { type: "status_change", from: "running", to: "idle" }],
        [6, { type: "status_change", from: "idle", to: "running" }],
        [20, { type: "status_change", from: "running", to: "idle", reason: "interrupted" }],
        [400, { type: "status_change", from: "idle", to: "paused" }],
      ]),
    );
    expect(elapsedMs(span!.startAt, span!.endAt!)).toBe(20_000);
    expect(span!.endSeq).toBe(5);
  });

  it("times the work a subagent's report or the runner sets off as a turn of its own", () => {
    const spans = turnSpans(
      timed([
        [0, { type: "user_message", text: "go" }],
        [0, { type: "status_change", from: "idle", to: "running" }],
        [10, { type: "status_change", from: "running", to: "idle" }],
        [40, { type: "user_message", text: "Survey: done", from: "subagent" }],
        [40, { type: "status_change", from: "idle", to: "running" }],
        [55, { type: "status_change", from: "running", to: "idle" }],
      ]),
    );
    expect(spans.map(s => [s.userSeq, elapsedMs(s.startAt, s.endAt!)])).toEqual([
      [1, 10_000],
      [4, 15_000],
    ]);
  });

  it("leaves out turns that were rewound", () => {
    const events = timed([
      [0, { type: "user_message", text: "one" }],
      [1, { type: "status_change", from: "idle", to: "running" }],
      [2, { type: "status_change", from: "running", to: "idle" }],
      [3, { type: "user_message", text: "two" }],
      [4, { type: "rewind", toSeq: 4 }],
    ]);
    expect(turnSpans(events).map(s => s.userSeq)).toEqual([1]);
  });

  it("formats durations the way people say them", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_900)).toBe("42s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_900_000 + 59_000)).toBe("1h 5m");
    expect(formatDuration(-5)).toBe("0s");
    expect(elapsedMs("2026-11-08T10:00:10Z", "2026-11-08T10:00:00Z")).toBe(0);
    expect(elapsedMs("nope", Date.now())).toBeNull();
  });
});
