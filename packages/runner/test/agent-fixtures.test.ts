// Replays real agent CLI runs (recorded in test/fixtures/agents, see its README) through
// the adapters, so a change in how we parse or call an agent is checked against what the
// CLI really printed rather than against hand-written samples.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind, NewEvent } from "@lemonlime/protocol";
import { describe, expect, it } from "vitest";
import { adapterFor, type AgentError } from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const replay = join(here, "fixtures/replay-agent.mjs");

interface Turn {
  events: NewEvent[];
  error?: AgentError;
}

/** Run every recorded prompt of a fixture through the real adapter, in order. */
async function replayFixture(kind: AgentKind, name: string): Promise<{ turns: Turn[]; state: Record<string, string> }> {
  const file = join(here, "fixtures/agents", kind, `${name}.jsonl`);
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map(l => JSON.parse(l) as { dir: string; line: string });
  const prompts = rows.flatMap(r => {
    if (r.dir === "argv") {
      const argv = JSON.parse(r.line) as string[];
      return [kind === "claude-code" ? argv[argv.indexOf("-p") + 1]! : argv.at(-1)!];
    }
    if (r.dir === "in") {
      const msg = JSON.parse(r.line) as { method?: string; params?: { prompt?: { text: string }[] } };
      return msg.method === "session/prompt" ? [msg.params!.prompt![0]!.text] : [];
    }
    return [];
  });

  const session = adapterFor(kind).createSession({ cwd: mkdtempSync(join(tmpdir(), "ll-fixture-")), autonomy: "edits", command: ["node", replay, file] });
  const turns: Turn[] = [];
  try {
    for (const prompt of prompts) {
      const events: NewEvent[] = [];
      const turn: Turn = { events };
      await session.runTurn({ prompt, signal: new AbortController().signal, emit: e => events.push(e) }).catch(err => (turn.error = err as AgentError));
      turns.push(turn);
    }
    return { turns, state: session.saveState() };
  } finally {
    await session.dispose();
  }
}

const ofType = <T extends NewEvent["type"]>(events: NewEvent[], type: T) => events.filter((e): e is Extract<NewEvent, { type: T }> => e.type === type);

/** Every tool call gets exactly one result, and no result is orphaned. */
function expectPairedTools(events: NewEvent[]) {
  const calls = ofType(events, "tool_call").map(e => e.callId);
  const results = ofType(events, "tool_result").map(e => e.callId);
  expect(new Set(calls).size).toBe(calls.length);
  expect([...results].sort()).toEqual([...calls].sort());
}

describe("Claude Code 2.1 (recorded)", () => {
  it("fixes a bug, runs the test once approved, and resumes the same session", async () => {
    const { turns, state } = await replayFixture("claude-code", "fix-bug");
    expect(turns).toHaveLength(2);
    const [first, second] = turns as [Turn, Turn];
    expect(first.error).toBeUndefined();
    expectPairedTools(first.events);
    const calls = ofType(first.events, "tool_call");
    expect(calls.map(e => e.name)).toEqual(expect.arrayContaining(["Bash", "Edit"]));
    // At autonomy "edits" the command went through the approval tool and was allowed.
    const testRun = calls.find(e => (e.input as { command?: string }).command === "node test.js")!;
    expect(ofType(first.events, "tool_result").find(e => e.callId === testRun.callId)).toMatchObject({ isError: false });
    expect(String(ofType(first.events, "tool_result").find(e => e.callId === testRun.callId)?.output)).toContain("1 test passed");
    expect(ofType(first.events, "agent_message").at(-1)?.text).toMatch(/add\.js/);

    // The replay only answers when called with `--resume <the session id from turn 1>`.
    expect(second.error).toBeUndefined();
    expect(ofType(second.events, "agent_message").map(e => e.text)).toEqual(["I changed only `add.js`."]);
    expect(state.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports a missing sign-in as auth_required, once, in the agent's own words", async () => {
    const { turns } = await replayFixture("claude-code", "not-logged-in");
    const [turn] = turns as [Turn];
    expect(turn.events).toEqual([]);
    expect(turn.error?.code).toBe("auth_required");
    expect(turn.error?.message).toBe("Not logged in · Please run /login");
  });
});

describe("Codex 0.167 (recorded)", () => {
  it("fixes a bug, runs the test, and resumes the same thread", async () => {
    const { turns, state } = await replayFixture("codex", "fix-bug");
    const [first, second] = turns as [Turn, Turn];
    expect(first.error).toBeUndefined();
    expectPairedTools(first.events);
    // Codex's startup warnings ("model metadata not found", ...) are not errors.
    expect(ofType(first.events, "error")).toEqual([]);
    const shell = ofType(first.events, "tool_call").filter(e => e.name === "shell");
    const testRun = shell.find(e => /node test\.js/.test(String((e.input as { command?: string }).command)));
    expect(testRun).toBeDefined();
    expect(ofType(first.events, "tool_result").find(e => e.callId === testRun!.callId)).toMatchObject({ output: "1 test passed\n", isError: false });
    expect(ofType(first.events, "tool_call").some(e => e.name === "edit_files")).toBe(true);

    expect(second.error).toBeUndefined();
    expect(ofType(second.events, "agent_message").map(e => e.text)).toEqual(["I changed `add.js`."]);
    expect(state.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports a missing sign-in as auth_required", async () => {
    const { turns } = await replayFixture("codex", "not-logged-in");
    const [turn] = turns as [Turn];
    expect(turn.error?.code).toBe("auth_required");
    expect(turn.error?.message).toMatch(/^unexpected status 401 Unauthorized/);
  });
});

describe("Codex 0.145 (recorded)", () => {
  it("unwraps the API error and reports an outdated CLI as agent_outdated", async () => {
    const { turns } = await replayFixture("codex", "outdated-cli");
    const [turn] = turns as [Turn];
    expect(ofType(turn.events, "error")).toEqual([]);
    expect(turn.error?.code).toBe("agent_outdated");
    expect(turn.error?.message).toBe("The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.");
  });
});

describe("OpenCode 1.18 over ACP (recorded)", () => {
  it("records each tool call with its real input and closes every message", async () => {
    const { turns, state } = await replayFixture("opencode", "fix-bug");
    const [first, second] = turns as [Turn, Turn];
    expect(first.error).toBeUndefined();
    expectPairedTools(first.events);
    const calls = ofType(first.events, "tool_call");
    expect(calls.map(e => e.name)).toEqual(["read", "read", "edit", "bash"]);
    // OpenCode announces calls with empty or partial input; we wait for the real one.
    for (const c of calls) expect(Object.keys(c.input as object).length).toBeGreaterThan(0);
    const bash = calls.find(e => e.name === "bash")!;
    expect((bash.input as { command?: string }).command).toBe("node test.js");
    expect(ofType(first.events, "tool_result").find(e => e.callId === bash.callId)).toMatchObject({ output: "1 test passed\n", isError: false });

    // Streamed chunks end with one whole message, so apps stop showing "typing".
    const lastFirst = ofType(first.events, "agent_message").at(-1)!;
    expect(lastFirst.partial).toBe(false);
    expect(lastFirst.text).toMatch(/add/);
    expect(
      ofType(second.events, "agent_message")
        .filter(e => !e.partial)
        .map(e => e.text),
    ).toEqual(["I changed add.js."]);
    expect(second.error).toBeUndefined();
    expect(state.sessionId).toMatch(/^ses_/);
  });
});
