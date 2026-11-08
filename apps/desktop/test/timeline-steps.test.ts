import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { buildTimeline, waitingOnYou, withoutQueued, type TimelineItem } from "../src/lib/timeline.ts";
import { unreadIndex } from "../src/lib/timelineView.ts";
import {
  bundleLabel,
  bundlePreview,
  bundleSteps,
  describeStep,
  isSubagentCall,
  latestSubagents,
  rowGap,
  runnerSubagentId,
  shortUrl,
  subagentState,
  subagentTask,
  toolName,
  type StepBundle,
} from "../src/lib/steps.ts";

const threadId = "abc123-thread";
const at = "2026-01-01T00:00:00.000Z";
const events = (list: NewEvent[]): ThreadEvent[] => list.map((e, i) => ThreadEvent.parse({ ...e, threadId, at, seq: i + 1 }));

const label = (name: string, input: unknown) => {
  const s = describeStep(name, input);
  return [s.verb, s.target].filter(Boolean).join(" ");
};

describe("step labels", () => {
  it("says what each kind of tool did, in plain English", () => {
    expect(label("Read", { file_path: "src/app.tsx" })).toBe("Read src/app.tsx");
    expect(label("Bash", { command: "pnpm test", description: "Run the tests" })).toBe("Ran pnpm test");
    expect(label("Edit", { file_path: "sum.js", old_string: "a", new_string: "b" })).toBe("Edited sum.js");
    expect(label("Write", { file_path: "notes.md", content: "" })).toBe("Wrote notes.md");
    expect(label("Grep", { pattern: "useAuth" })).toBe("Searched for “useAuth”");
    expect(label("Glob", { pattern: "**/*.ts" })).toBe("Looked for files named **/*.ts");
    expect(label("LS", { path: "src" })).toBe("Listed src");
    expect(label("WebFetch", { url: "https://docs.example.com/" })).toBe("Fetched docs.example.com");
    expect(label("WebSearch", { query: "vitest mocks" })).toBe("Searched the web for “vitest mocks”");
    expect(label("TodoWrite", { todos: [] })).toBe("Updated the to-do list");
  });

  it("knows other agents' names for the same tools", () => {
    // Codex
    expect(label("shell", { command: "bash -lc 'ls -la'" })).toBe("Ran ls -la");
    expect(label("edit_files", { changes: [{ path: "a.ts" }, { path: "b.ts" }] })).toBe("Edited a.ts");
    expect(describeStep("edit_files", { changes: [{ path: "a.ts" }, { path: "b.ts" }] }).detail).toBe("and 1 more");
    expect(label("apply_patch", { input: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch" })).toBe("Edited src/x.ts");
    expect(label("web_search", { query: "rust" })).toBe("Searched the web for “rust”");
    // ACP agents
    expect(label("read", { filePath: "README.md" })).toBe("Read README.md");
    expect(label("Read README.md", null)).toBe("Read README.md");
  });

  it("uses the running form while a step runs, and marks background commands", () => {
    expect(describeStep("Read", { file_path: "a.ts" }).doing).toBe("Reading");
    const bg = describeStep("Bash", { command: "pnpm dev", run_in_background: true });
    expect([bg.verb, bg.target, bg.detail]).toEqual(["Started", "pnpm dev", "in the background"]);
  });

  it("names unknown and MCP tools by their own name and server", () => {
    expect(toolName("mcp__github__get_issue")).toEqual({ tool: "get_issue", server: "github" });
    expect(toolName("lemonlime-subagents.spawn_subagent")).toEqual({ tool: "spawn_subagent", server: "lemonlime-subagents" });
    const s = describeStep("mcp__github__get_issue", { number: 3, title: "Crash on start" });
    expect([s.verb, s.target, s.detail]).toEqual(["Used", "get_issue", "Crash on start from github"]);
  });

  it("shortens long paths and URLs", () => {
    expect(describeStep("Read", { file_path: "/Users/me/projects/very/deep/folder/structure/src/components/App.tsx" }).target).toBe(
      "…/folder/structure/src/components/App.tsx",
    );
    expect(shortUrl("https://www.example.com/docs/guide/")).toBe("example.com/docs/guide");
    expect(shortUrl("not a url")).toBe("not a url");
  });
});

const tool = (key: string, name: string, input: unknown, result: { isError: boolean } | null = { isError: false }): TimelineItem => ({
  kind: "tool",
  key,
  seq: Number(key.slice(1)),
  at,
  callId: key,
  name,
  input,
  result: result ? { seq: 0, output: "", isError: result.isError } : null,
});
const agent = (key: string, text: string): TimelineItem => ({ kind: "agent", key, seq: Number(key.slice(1)), at, text, streaming: false });

describe("bundling steps", () => {
  it("folds runs of the same kind into one row and leaves single steps alone", () => {
    const rows = bundleSteps([
      tool("e1", "Read", { file_path: "a.ts" }),
      tool("e2", "Read", { file_path: "b.ts" }),
      tool("e3", "Read", { file_path: "src/c.ts" }),
      tool("e4", "Bash", { command: "pnpm test" }),
      agent("e5", "Looks fine"),
      tool("e6", "Bash", { command: "pnpm lint" }),
      tool("e7", "Bash", { command: "pnpm build" }),
    ]);
    expect(rows.map(r => r.kind)).toEqual(["bundle", "tool", "agent", "bundle"]);
    const reads = rows[0] as StepBundle;
    expect(reads.key).toBe("bundle:e1");
    expect(bundleLabel(reads)).toBe("Read 3 files");
    expect(bundlePreview(reads)).toBe("a.ts, b.ts, c.ts");
    expect(bundleLabel(rows[3] as StepBundle)).toBe("Ran 2 commands");
    expect(bundleLabel(rows[3] as StepBundle, true)).toBe("Running 2 commands");
  });

  it("keeps the bundle's key as it grows, so it stays one row while the agent works", () => {
    const two = bundleSteps([tool("e1", "Grep", { pattern: "a" }), tool("e2", "Grep", { pattern: "b" })]);
    const three = bundleSteps([tool("e1", "Grep", { pattern: "a" }), tool("e2", "Grep", { pattern: "b" }), tool("e3", "Grep", { pattern: "c" })]);
    expect(two[0]!.key).toBe(three[0]!.key);
    expect(bundleLabel(three[0] as StepBundle)).toBe("Ran 3 searches");
  });

  it("says when the same file was read again", () => {
    const rows = bundleSteps([tool("e1", "Read", { file_path: "a.ts" }), tool("e2", "Read", { file_path: "a.ts" })]);
    expect(bundleLabel(rows[0] as StepBundle)).toBe("Read a.ts twice");
  });

  it("only bundles unknown tools with the same name, and never bundles subagents", () => {
    const rows = bundleSteps([
      tool("e1", "mcp__github__get_issue", {}),
      tool("e2", "mcp__github__list_prs", {}),
      tool("e3", "Task", { description: "Fix tests" }),
      tool("e4", "Task", { description: "Write docs" }),
    ]);
    expect(rows.map(r => r.kind)).toEqual(["tool", "tool", "tool", "tool"]);
  });

  it("counts a bundle in the New divider by its first step", () => {
    const rows = bundleSteps([agent("e1", "hi"), tool("e2", "Read", { file_path: "a" }), tool("e3", "Read", { file_path: "b" })]);
    expect(unreadIndex(rows, 1)).toBe(1);
  });
});

describe("row spacing", () => {
  it("keeps steps close together and gives messages and new turns more room", () => {
    expect(rowGap(undefined, "agent")).toBe("none");
    expect(rowGap("tool", "bundle")).toBe("step");
    expect(rowGap("reasoning", "diff")).toBe("step");
    expect(rowGap("tool", "agent")).toBe("block");
    expect(rowGap("notice", "tool")).toBe("block");
    // A reply's buttons under it already give it room.
    expect(rowGap("agent", "tool")).toBe("step");
    expect(rowGap("agent", "user")).toBe("turn");
  });
});

describe("subagents", () => {
  it("recognises subagent calls from Claude Code and from the runner's tools", () => {
    expect(isSubagentCall("Task")).toBe(true);
    expect(isSubagentCall("Agent")).toBe(true);
    expect(isSubagentCall("mcp__lemonlime-subagents__spawn_subagent")).toBe(true);
    expect(isSubagentCall("Read")).toBe(false);
    expect(subagentTask({ description: "Fix the tests", prompt: "Long prompt…" })).toBe("Fix the tests");
    expect(subagentTask({ request_id: "r1", task: "Write the docs\nwith examples" })).toBe("Write the docs");
  });

  it("reads the runner's subagent id from its reply and follows its status", () => {
    const reply = { content: [{ type: "text", text: "Started subagent sub-42. Its reply will come to you as a message; carry on meanwhile." }] };
    expect(runnerSubagentId(reply)).toBe("sub-42");
    expect(runnerSubagentId("Started subagent abc. Its reply…")).toBe("abc");
    expect(runnerSubagentId("Couldn't start it.")).toBeNull();
    const map = latestSubagents(
      events([
        { type: "subagent_update", subagents: [{ id: "sub-42", parentId: null, task: "Fix", status: "working", startedAt: at }] },
        { type: "subagent_update", subagents: [{ id: "sub-42", parentId: null, task: "Fix", status: "idle", startedAt: at }] },
      ]),
    );
    expect(subagentState({ result: { seq: 1, output: "", isError: false } }, map.get("sub-42"), true)).toBe("done");
  });

  it("works out a Claude Code subagent's state from its call", () => {
    expect(subagentState({ result: null }, undefined, true)).toBe("running");
    expect(subagentState({ result: null }, undefined, false)).toBe("stopped");
    expect(subagentState({ result: { seq: 1, output: "report", isError: false } }, undefined, false)).toBe("done");
    expect(subagentState({ result: { seq: 1, output: "boom", isError: true } }, undefined, true)).toBe("failed");
  });
});

describe("what waits above the composer", () => {
  it("lists approvals not answered yet and queued messages in order, and drops queued ones from the timeline", () => {
    const items = buildTimeline(
      events([
        { type: "user_message", text: "go", clientMsgId: "m1" },
        { type: "approval_request", requestId: "r1", tool: "Bash", input: {}, summary: "rm -rf build" },
        { type: "approval_request", requestId: "r2", tool: "Bash", input: {}, summary: "pnpm test" },
        { type: "approval_result", requestId: "r1", decision: "allow", by: "user" },
        {
          type: "queue_update",
          queue: [
            { clientMsgId: "q1", text: "then this", queuedAt: at },
            { clientMsgId: "q2", text: "and this", queuedAt: at },
          ],
        },
      ]),
    );
    const stack = waitingOnYou(items);
    expect(stack.approvals.map(a => a.requestId)).toEqual(["r2"]);
    expect(stack.queued.map(q => [q.text, q.index, q.count])).toEqual([
      ["then this", 0, 2],
      ["and this", 1, 2],
    ]);
    const shown = withoutQueued(items);
    expect(shown.filter(i => i.kind === "user").map(i => (i.kind === "user" ? i.text : ""))).toEqual(["go"]);
    // The approvals stay in the timeline as one-line records.
    expect(shown.filter(i => i.kind === "approval")).toHaveLength(2);
  });

  it("returns the same list when nothing is queued", () => {
    const items = buildTimeline(events([{ type: "user_message", text: "hi" }]));
    expect(withoutQueued(items)).toBe(items);
  });
});
