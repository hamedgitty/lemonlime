import { describe, expect, it } from "vitest";
import { agentLoopState, contextPercent, modeAfterPlan, parseClientMessage, ThreadEvent, type NewEvent } from "../src/index.ts";

const at = "2026-11-08T10:00:00.000Z";
const history = (events: NewEvent[]): ThreadEvent[] => events.map((e, i) => ThreadEvent.parse({ ...e, threadId: "thread-abc123", seq: i + 1, at }));

describe("the agent loop state the apps show", () => {
  it("keeps the latest to-do list until it is done and the user moves on", () => {
    const working = history([
      { type: "user_message", text: "go" },
      { type: "todo_snapshot", items: [{ text: "A", status: "in_progress" }] },
      { type: "todo_snapshot", items: [{ text: "A", status: "completed" }] },
    ]);
    expect(agentLoopState(working).todos).toEqual([{ text: "A", status: "completed" }]);
    expect(agentLoopState([...working, ...history([{ type: "user_message", text: "next" }]).map(e => ({ ...e, seq: 10 }))]).todos).toBeNull();
    expect(agentLoopState(history([{ type: "todo_snapshot", items: [] }])).todos).toBeNull();
  });

  it("knows the open question, the latest usage, plan and options", () => {
    const events = history([
      { type: "options_change", options: { model: null, reasoning: null, permission: "plan", exitPlanTo: "full" } },
      { type: "user_message", text: "plan it" },
      { type: "question_request", requestId: "q1", questions: [{ question: "Which?", options: [{ label: "A" }] }] },
      { type: "question_result", requestId: "q1", answers: [["A"]], by: "user" },
      { type: "question_request", requestId: "q2", questions: [{ question: "And?", options: [] }] },
      { type: "context_usage", used: 150_000, window: 200_000 },
      { type: "plan_proposal", plan: "# Plan" },
    ]);
    const s = agentLoopState(events);
    expect(s.question?.requestId).toBe("q2");
    expect(s.question?.questions[0]?.multiSelect).toBe(false);
    expect(s.usage).toEqual({ used: 150_000, window: 200_000 });
    expect(s.plan).toMatchObject({ plan: "# Plan", open: true });
    expect(modeAfterPlan(s.options)).toBe("full");
    expect(modeAfterPlan(null)).toBe("edits");
    expect(contextPercent(s.usage)).toBe(75);
    expect(contextPercent({ used: 300, window: 200 })).toBe(100);
    expect(contextPercent(null)).toBeNull();
  });

  it("leaves a plan and a finished list waiting when the next message isn't a person's", () => {
    const events = history([
      { type: "user_message", text: "plan it" },
      { type: "todo_snapshot", items: [{ text: "A", status: "completed" }] },
      { type: "plan_proposal", plan: "# Plan" },
      { type: "user_message", text: "Here is what I found", from: "subagent" },
      { type: "user_message", text: "Carry on from where you stopped", from: "runner" },
    ]);
    const waiting = agentLoopState(events);
    expect(waiting.plan).toMatchObject({ plan: "# Plan", open: true });
    expect(waiting.todos).toEqual([{ text: "A", status: "completed" }]);

    const answered = agentLoopState([...events, ...history([{ type: "user_message", text: "go ahead" }]).map(e => ({ ...e, seq: 10 }))]);
    expect(answered.plan?.open).toBe(false);
    expect(answered.todos).toBeNull();
  });

  it("parses the new client messages", () => {
    expect(parseClientMessage(JSON.stringify({ type: "set_options", model: null, permission: "plan" }))).toEqual({
      type: "set_options",
      model: null,
      permission: "plan",
    });
    expect(parseClientMessage(JSON.stringify({ type: "set_options", permission: "yolo" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "answer_question", requestId: "q1", answers: [["A"], ["typed"]] }))).toMatchObject({
      answers: [["A"], ["typed"]],
    });
    expect(parseClientMessage(JSON.stringify({ type: "answer_question", requestId: "q1", answers: null }))).toMatchObject({ answers: null });
  });
});
