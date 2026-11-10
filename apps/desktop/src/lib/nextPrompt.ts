import type { ThreadEvent } from "@lemonlime/protocol";

/**
 * A likely next message, worked out from the thread itself (no model is asked), shown
 * greyed in the empty composer once the agent finishes a turn. Tab takes it.
 */

/** What the app knows about the thread's branch, when it knows. */
export interface BranchFacts {
  uncommittedFiles?: number;
}

/** A command that runs tests, in the shapes agents send them (a string or an argv list). */
const TEST_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|mocha|rspec|phpunit|cargo\s+(?:test|nextest)|go\s+test|dotnet\s+test|mix\s+test|gradle\w*\s+test|mvn\s+test|swift\s+test|deno\s+test|make\s+(?:test|check)|pnpm\s+check)\b/i;
/** Output that says tests failed. */
const TESTS_FAILED =
  /\b\d+\s+(?:tests?\s+)?(?:failed|failing|failures?)\b|\btests?\s+failed\b|^\s*FAIL(?:ED)?\b|\bFAILURES?\b|\btest result: FAILED\b|\bAssertionError\b/im;
/** The agent offering to do something next. */
const OFFER =
  /\b(?:want me to|should i|shall i|would you like(?: me)? to|do you want(?: me)? to|i can (?:also |now )?\w+[^.?!]*\?|let me know if you(?:'d| would)? (?:like|want)|ready (?:for me )?to (?:go|proceed|start)|happy to\b[^.?!]*\?|go ahead\?|proceed\?)/i;

/** Every string in a tool's input or output, joined by spaces (argv lists read as one command). */
function text(v: unknown, depth = 0): string {
  if (typeof v === "string") return v;
  if (depth > 4 || v === null || typeof v !== "object") return "";
  return (Array.isArray(v) ? v : Object.values(v)).map(x => text(x, depth + 1)).join(" ");
}

/** The events of the last turn: everything after the last message that started one, whoever sent it. */
function lastTurn(events: readonly ThreadEvent[]): readonly ThreadEvent[] | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === "user_message") return events.slice(i + 1);
  return null;
}

/** Whether the last test run in the turn failed (a later passing run clears it). */
function testsFailed(turn: readonly ThreadEvent[]): boolean {
  const testCalls = new Set<string>();
  let failed = false;
  for (const e of turn) {
    if (e.type === "tool_call" && TEST_COMMAND.test(text(e.input))) testCalls.add(e.callId);
    if (e.type === "tool_result" && testCalls.has(e.callId)) {
      const out = text(e.output);
      failed = e.isError || TESTS_FAILED.test(out);
    }
  }
  return failed;
}

function lastAgentText(turn: readonly ThreadEvent[]): string | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const e = turn[i]!;
    if (e.type === "agent_message" && !e.partial && e.text.trim()) return e.text;
  }
  return null;
}

/** The end of a message: its last paragraph, where agents put their offer. */
function ending(message: string): string {
  const paragraphs = message.trim().split(/\n\s*\n/);
  return paragraphs[paragraphs.length - 1]!.slice(-400);
}

/** Events that say where a turn ended up; the rest (status, usage, notices) don't. */
const DECIDING = new Set<ThreadEvent["type"]>([
  "agent_message",
  "tool_call",
  "tool_result",
  "error",
  "approval_request",
  "approval_result",
  "question_request",
  "question_result",
  "plan_proposal",
]);

export function suggestNextPrompt(events: readonly ThreadEvent[], branch: BranchFacts = {}): string | null {
  const turn = lastTurn(events);
  if (!turn || turn.length === 0) return null;
  // The agent is waiting on an answer, or the turn ended in an error the person has to sort out.
  const lastReal = [...turn].reverse().find(e => DECIDING.has(e.type));
  if (!lastReal || lastReal.type === "approval_request" || lastReal.type === "question_request") return null;
  if (lastReal.type === "error") return lastReal.code === "auth_required" || lastReal.code === "usage_limit" ? null : "Try that again";

  if (turn.some(e => e.type === "plan_proposal")) return "Implement the plan";
  if (testsFailed(turn)) return "Fix the failing tests";

  const said = lastAgentText(turn);
  if (said && OFFER.test(ending(said))) return "Yes, go ahead";
  // Asked something else: the person has to answer in their own words.
  if (said && /\?\s*$/.test(said.trim())) return null;

  const changedFiles = turn.some(e => e.type === "file_diff");
  if ((branch.uncommittedFiles ?? 0) > 0 && changedFiles) return "Commit this";
  return null;
}
