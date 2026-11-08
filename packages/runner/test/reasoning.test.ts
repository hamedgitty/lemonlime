import { describe, expect, it } from "vitest";
import { AcpTranslator, parseClaudeLine, parseCodexLine } from "../src/index.ts";

describe("the agent's reasoning", () => {
  it("Claude Code: thinking blocks become reasoning, hidden ones as a bare row, redacted ones are left out", () => {
    const line = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        session_id: "s-1",
        message: {
          content: [
            { type: "thinking", thinking: "  The tests live in test/, so run them first.\n", signature: "sig" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "thinking", thinking: "   " },
            // What Claude Code prints when it keeps its thinking to itself.
            { type: "thinking", thinking: "", signature: "sig2" },
            { type: "text", text: "Running the tests." },
          ],
        },
      }),
    );
    expect(line.events).toEqual([
      { type: "agent_reasoning", text: "The tests live in test/, so run them first.", partial: false },
      { type: "agent_reasoning", text: "", partial: false },
      { type: "agent_message", text: "Running the tests.", partial: false },
    ]);
  });

  it("Codex: finished reasoning items become reasoning; commands carry their exit code", () => {
    expect(parseCodexLine(JSON.stringify({ type: "item.started", item: { id: "r1", type: "reasoning", text: "" } })).events).toEqual([]);
    expect(
      parseCodexLine(JSON.stringify({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "**Checking the build**\n\nLook at the config." } }))
        .events,
    ).toEqual([{ type: "agent_reasoning", text: "**Checking the build**\n\nLook at the config.", partial: false }]);
    expect(
      parseCodexLine(
        JSON.stringify({
          type: "item.completed",
          item: { id: "c1", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" },
        }),
      ).events,
    ).toEqual([{ type: "tool_result", callId: "c1", output: "", isError: true, exitCode: 1 }]);
  });

  it("ACP: thought chunks stream as partial reasoning and close with a whole copy", () => {
    const t = new AcpTranslator();
    const thought = (text: string) => t.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
    expect(thought("Look at ")).toEqual([]);
    expect(thought("the router.")).toEqual([]);
    expect(t.flushText()).toEqual([{ type: "agent_reasoning", text: "Look at the router.", partial: true }]);
    expect(thought(" Then the tests.")).toEqual([]);
    // A message starting ends the reasoning.
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Found it." } })).toEqual([
      { type: "agent_reasoning", text: "Look at the router. Then the tests.", partial: false },
    ]);
    expect(t.flushText()).toEqual([{ type: "agent_message", text: "Found it.", partial: true }]);
    // Thinking again after a message closes the message first.
    expect(thought("One more check.")).toEqual([{ type: "agent_message", text: "Found it.", partial: false }]);
    // A tool call ends the reasoning too.
    const call = t.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "in_progress", rawInput: { path: "a.ts" } });
    expect(call[0]).toEqual({ type: "agent_reasoning", text: "One more check.", partial: false });
    expect(call[1]).toMatchObject({ type: "tool_call", callId: "c1" });
    // Reasoning still open at the end of the turn is closed.
    thought("Done.");
    expect(t.finish()).toEqual([{ type: "agent_reasoning", text: "Done.", partial: false }]);
  });
});
