import { describe, expect, it } from "vitest";
import { continuableRestart } from "../src/lib/recovery.ts";
import type { TimelineItem } from "../src/lib/timeline.ts";

const at = "2026-01-01T00:00:00.000Z";
const user = (key: string): TimelineItem => ({ kind: "user", key, seq: 1, at, text: "hi" }) as TimelineItem;
const cut = (key: string): TimelineItem => ({ kind: "error", key, seq: 2, at, message: "cut short", code: "turn_outcome_unknown", fatal: false });
const other = (key: string): TimelineItem => ({ kind: "error", key, seq: 3, at, message: "boom", code: "agent_crashed", fatal: false });

describe("continuableRestart", () => {
  it("offers Continue on the newest cut-short notice", () => {
    expect(continuableRestart([user("u1"), cut("e1"), other("e2")])).toBe("e1");
    expect(continuableRestart([cut("e1"), user("u1"), cut("e2")])).toBe("e2");
  });
  it("offers nothing once a message was sent after it, or without one", () => {
    expect(continuableRestart([cut("e1"), user("u2")])).toBeNull();
    expect(continuableRestart([user("u1"), other("e1")])).toBeNull();
    expect(continuableRestart([])).toBeNull();
  });
});
