import { describe, expect, it } from "vitest";
import { backgroundWork, childProgress, childrenSettled, ThreadEvent, type NewEvent } from "../src/index.ts";

const history = (events: NewEvent[]): ThreadEvent[] =>
  events.map((e, i) => ThreadEvent.parse({ ...e, threadId: "thread-abc123", seq: i + 1, at: new Date(Date.UTC(2026, 10, 8, 10, 0, i)).toISOString() }));

describe("background work", () => {
  it("follows the agent's Task subagents through the latest turn", () => {
    const events = history([
      { type: "user_message", text: "first" },
      { type: "status_change", from: "idle", to: "running" },
      { type: "tool_call", callId: "old", name: "Task", input: { description: "Earlier work" } },
      { type: "tool_result", callId: "old", output: "ok" },
      { type: "status_change", from: "running", to: "idle" },
      { type: "user_message", text: "second" },
      { type: "status_change", from: "idle", to: "running" },
      { type: "tool_call", callId: "a", name: "Task", input: { description: "Read the docs\nmore", prompt: "x" } },
      { type: "tool_call", callId: "b", name: "Agent", input: { prompt: "Check the tests" } },
      { type: "tool_call", callId: "c", name: "Task", input: {} },
      { type: "tool_result", callId: "a", output: "done" },
      { type: "tool_result", callId: "c", output: "boom", isError: true },
    ]);
    const w = backgroundWork(events);
    expect(w.children.map(c => [c.id, c.title, c.state])).toEqual([
      ["a", "Read the docs", "done"],
      ["b", "Check the tests", "running"],
      ["c", "Subagent", "failed"],
    ]);
    expect(childProgress(w.children)).toEqual({ done: 1, running: 1, waiting: 0, failed: 1, total: 3 });
    expect(childrenSettled(w.children)).toBe(false);

    // The turn ended without b's result: it was cut short.
    const after = backgroundWork([...events, ...history([{ type: "status_change", from: "running", to: "idle" }]).map(e => ({ ...e, seq: 99 }))]);
    expect(after.children.find(c => c.id === "b")?.state).toBe("failed");
    expect(childrenSettled(after.children)).toBe(true);
  });

  it("shows the runner's subagents, with waiting ones, and drops finished ones from earlier turns", () => {
    const events = history([
      {
        type: "subagent_update",
        subagents: [{ id: "sub-old", parentId: null, task: "Old", status: "idle", startedAt: "2026-11-08T09:00:00.000Z" }],
      },
      { type: "user_message", text: "go" },
      {
        type: "subagent_update",
        subagents: [
          { id: "sub-old", parentId: null, task: "Old", status: "idle", startedAt: "2026-11-08T09:00:00.000Z" },
          { id: "sub-1", parentId: null, task: "Survey", status: "waiting", startedAt: "2026-11-08T10:00:05.000Z" },
          { id: "sub-2", parentId: "sub-1", task: "Dig", status: "working", startedAt: "2026-11-08T10:00:06.000Z" },
        ],
      },
    ]);
    const w = backgroundWork(events);
    expect(w.children.map(c => [c.id, c.state, c.parentId])).toEqual([
      ["sub-1", "waiting", null],
      ["sub-2", "running", "sub-1"],
    ]);
    expect(childProgress(w.children).waiting).toBe(1);
    expect(childrenSettled([])).toBe(true);
  });

  it("lists commands left running in the background until they end", () => {
    const events = history([
      { type: "user_message", text: "serve it" },
      { type: "status_change", from: "idle", to: "running" },
      { type: "tool_call", callId: "s1", name: "Bash", input: { command: "pnpm dev", description: "Start the dev server", run_in_background: true } },
      { type: "tool_result", callId: "s1", output: "Command running in background with ID: bash_1" },
      { type: "tool_call", callId: "s2", name: "Bash", input: { command: "pnpm test --watch", run_in_background: true } },
      { type: "tool_result", callId: "s2", output: "Command running in background with ID: bash_2" },
      { type: "tool_call", callId: "fg", name: "Bash", input: { command: "ls" } },
      { type: "tool_call", callId: "o1", name: "BashOutput", input: { bash_id: "bash_2" } },
      { type: "tool_result", callId: "o1", output: "<status>completed</status>" },
    ]);
    const w = backgroundWork(events);
    expect(w.commands).toEqual([{ id: "s1", command: "pnpm dev", description: "Start the dev server", startedAt: events[2]!.at }]);
    const killed = backgroundWork([
      ...events,
      ...history([{ type: "tool_call", callId: "k", name: "KillShell", input: { shell_id: "bash_1" } }]).map(e => ({ ...e, seq: 50 })),
    ]);
    expect(killed.commands).toEqual([]);
    const stopped = backgroundWork([...events, ...history([{ type: "status_change", from: "running", to: "stopped" }]).map(e => ({ ...e, seq: 50 }))]);
    expect(stopped.commands).toEqual([]);
  });
});
