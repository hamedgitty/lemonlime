import { describe, expect, it } from "vitest";
import { AcpTranslator, answerAgentRequest, parseClaudeLine, parseCodexLine, splitCommand } from "../src/index.ts";

describe("Claude Code stream-json", () => {
  it("captures the session id and turns content blocks into events", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }))).toEqual({ events: [], sessionId: "s-1" });

    const assistant = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        session_id: "s-1",
        message: {
          content: [
            { type: "text", text: "Looking at the tests." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
    );
    expect(assistant.events).toEqual([
      { type: "agent_message", text: "Looking at the tests.", partial: false },
      { type: "tool_call", callId: "t1", name: "Bash", input: { command: "npm test" } },
    ]);

    const result = parseClaudeLine(
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 passed" }], is_error: false }] } }),
    );
    expect(result.events).toEqual([{ type: "tool_result", callId: "t1", output: "3 passed", isError: false }]);
  });

  it("reports failed results and ignores noise", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })).failure).toMatch(/error_max_turns/);
    expect(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", result: "done" })).failure).toBeUndefined();
    expect(parseClaudeLine("not json").events).toEqual([]);
  });
});

describe("Codex exec --json", () => {
  it("maps items to events", () => {
    expect(parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "th-9" })).threadId).toBe("th-9");
    expect(parseCodexLine(JSON.stringify({ type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } })).events).toEqual([
      { type: "tool_call", callId: "c1", name: "shell", input: { command: "ls" } },
    ]);
    expect(
      parseCodexLine(JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", aggregated_output: "boom", exit_code: 1, status: "failed" } })).events,
    ).toEqual([{ type: "tool_result", callId: "c1", output: "boom", isError: true }]);
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } })).events).toEqual([
      { type: "agent_message", text: "Done.", partial: false },
    ]);
    expect(parseCodexLine(JSON.stringify({ type: "item.completed", item: { id: "r", type: "reasoning", text: "hmm" } })).events).toEqual([]);
  });

  it("reports failures", () => {
    expect(parseCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } })).failure).toBe("rate limited");
  });
});

describe("ACP translation", () => {
  it("coalesces streamed text and closes it with a whole message before a tool call", () => {
    const t = new AcpTranslator();
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } })).toEqual([]);
    expect(t.flushText()).toEqual([{ type: "agent_message", text: "Hel", partial: true }]);
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } })).toEqual([]);
    const out = t.update({ sessionUpdate: "tool_call", toolCallId: "x", title: "Read file", kind: "read", status: "in_progress", rawInput: { path: "a" } });
    expect(out).toEqual([
      { type: "agent_message", text: "Hello", partial: false },
      { type: "tool_call", callId: "x", name: "Read file", input: { path: "a" } },
    ]);
    expect(t.update({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] })).toEqual([
      { type: "tool_result", callId: "x", output: "ok", isError: false },
    ]);
    expect(t.finish()).toEqual([]);
  });

  it("holds a pending call until it starts, keeping the latest input and the first name", () => {
    const t = new AcpTranslator();
    expect(t.update({ sessionUpdate: "tool_call", toolCallId: "b", title: "bash", kind: "execute", status: "pending", rawInput: { cwd: "/w" } })).toEqual([]);
    expect(t.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", title: "node test.js", rawInput: { command: "node test.js" } })).toEqual([
      { type: "tool_call", callId: "b", name: "bash", input: { command: "node test.js" } },
    ]);
    expect(t.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", rawInput: { command: "node test.js" } })).toEqual([]);
    expect(t.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed", rawOutput: { exit: 1 } })).toEqual([
      { type: "tool_result", callId: "b", output: { exit: 1 }, isError: true },
    ]);
    // A call that never started is still recorded when the turn ends.
    t.update({ sessionUpdate: "tool_call", toolCallId: "c", title: "read", status: "pending", rawInput: {} });
    expect(t.finish()).toEqual([{ type: "tool_call", callId: "c", name: "read", input: null }]);
  });

  it("grants permissions according to autonomy", () => {
    const options = [
      { optionId: "yes", kind: "allow_once" },
      { optionId: "no", kind: "reject_once" },
    ];
    const pick = (kind: string, autonomy: "full" | "edits") =>
      (answerAgentRequest("session/request_permission", { options, toolCall: { kind } }, autonomy) as { result: { outcome: { optionId: string } } }).result.outcome.optionId;
    expect(pick("execute", "full")).toBe("yes");
    expect(pick("edit", "edits")).toBe("yes");
    expect(pick("execute", "edits")).toBe("no");
    expect(answerAgentRequest("fs/read_text_file", {}, "full")).toHaveProperty("error");
  });
});

describe("splitCommand", () => {
  it("handles quotes", () => {
    expect(splitCommand(`gemini --experimental-acp`)).toEqual(["gemini", "--experimental-acp"]);
    expect(splitCommand(`node "my agent.js" --flag 'a b' ""`)).toEqual(["node", "my agent.js", "--flag", "a b", ""]);
  });
});
