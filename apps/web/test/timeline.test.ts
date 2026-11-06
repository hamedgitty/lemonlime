import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@lemonlime/protocol";
import { addEvent, buildTimeline, diffLines } from "../src/lib/timeline.ts";

const T = "thread-aaaaaa";
let seq = 0;
const at = "2026-01-01T00:00:00.000Z";
const ev = <E extends Record<string, unknown>>(e: E) => ({ threadId: T, seq: ++seq, at, ...e }) as unknown as ThreadEvent;

describe("buildTimeline", () => {
  it("joins streaming chunks and replaces them with the whole message", () => {
    seq = 0;
    const events = [
      ev({ type: "agent_message", text: "Hel", partial: true }),
      ev({ type: "agent_message", text: "lo", partial: true }),
    ];
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
  it("keeps events sorted and drops duplicates", () => {
    seq = 0;
    const [a, b, c] = [ev({ type: "agent_message", text: "a", partial: false }), ev({ type: "agent_message", text: "b", partial: false }), ev({ type: "agent_message", text: "c", partial: false })];
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
});
