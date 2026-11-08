import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { buildTimeline, foldFinishedTurns } from "../src/lib/timeline.ts";
import {
  cleanTerminalText,
  collapseLongText,
  commandOf,
  commandOutput,
  liveTurnStart,
  terminalTail,
  tocEntries,
  tocLabel,
  unreadIndex,
} from "../src/lib/timelineView.ts";

const threadId = "abc123-thread";
/** Events one per `[seconds after midnight, event]`, numbered from 1. */
const timed = (events: [number, NewEvent][]): ThreadEvent[] =>
  events.map(([s, e], i) => ThreadEvent.parse({ ...e, threadId, seq: i + 1, at: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString() }));

describe("reasoning in the timeline", () => {
  it("joins streamed reasoning, replaces it with the whole copy, and times it from the event before", () => {
    const items = buildTimeline(
      timed([
        [0, { type: "user_message", text: "fix it" }],
        [0, { type: "status_change", from: "idle", to: "running" }],
        [3, { type: "agent_reasoning", text: "Look at ", partial: true }],
        [9, { type: "agent_reasoning", text: "the router", partial: true }],
        [12, { type: "agent_reasoning", text: "Look at the router.", partial: false }],
        [13, { type: "agent_message", text: "Found it.", partial: false }],
      ]),
    );
    const r = items.find(i => i.kind === "reasoning");
    expect(r).toMatchObject({ text: "Look at the router.", streaming: false, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:12.000Z" });
    expect(items.map(i => i.kind)).toEqual(["user", "status", "reasoning", "agent"]);
  });

  it("ends a streaming message when reasoning starts, and reasoning when anything else arrives", () => {
    const items = buildTimeline(
      timed([
        [0, { type: "agent_message", text: "First", partial: true }],
        [1, { type: "agent_reasoning", text: "Hmm", partial: true }],
        [2, { type: "tool_call", callId: "c1", name: "Read", input: {} }],
      ]),
    );
    expect(items[0]).toMatchObject({ kind: "agent", streaming: false });
    expect(items[1]).toMatchObject({ kind: "reasoning", text: "Hmm", streaming: false });
  });

  it("still reads old histories without any reasoning", () => {
    const items = buildTimeline(
      timed([
        [0, { type: "user_message", text: "hi" }],
        [1, { type: "agent_message", text: "hello", partial: false }],
      ]),
    );
    expect(items.map(i => i.kind)).toEqual(["user", "agent"]);
  });
});

describe("turn durations", () => {
  const events = timed([
    [0, { type: "user_message", text: "one" }],
    [0, { type: "status_change", from: "idle", to: "running" }],
    [10, { type: "tool_call", callId: "c1", name: "Bash", input: { command: "ls" } }],
    [20, { type: "tool_result", callId: "c1", output: "a" }],
    [60, { type: "agent_message", text: "Done", partial: false }],
    [72, { type: "status_change", from: "running", to: "idle" }],
    [100, { type: "user_message", text: "two" }],
    [100, { type: "status_change", from: "idle", to: "running" }],
  ]);

  it("puts how long the turn took on the status change that ended it", () => {
    const items = buildTimeline(events);
    expect(items.find(i => i.kind === "status" && i.to === "idle")).toMatchObject({ workedMs: 72_000 });
    expect(items.find(i => i.kind === "status" && i.to === "running")).not.toHaveProperty("workedMs");
  });

  it("and on the fold of a finished turn", () => {
    const shown = foldFinishedTurns(buildTimeline(events));
    expect(shown.find(i => i.kind === "fold")).toMatchObject({ workedMs: 72_000 });
  });

  it("knows when the turn now running began", () => {
    const items = buildTimeline(events, [{ clientMsgId: "p1", text: "three", at: "2026-01-01T00:05:00.000Z" }]);
    expect(liveTurnStart(items)).toBe("2026-01-01T00:01:40.000Z");
    expect(liveTurnStart([])).toBeNull();
  });
});

describe("images sent with a message", () => {
  it("lists the images that can be shown, and every file by name", () => {
    const [user] = buildTimeline(
      timed([
        [
          0,
          {
            type: "user_message",
            text: "look",
            attachments: [
              { id: "up-1", name: "shot.png", size: 10, path: ".lemonlime-attachments/up-1/shot.png" },
              { id: "up-2", name: "photo.heic", size: 10, path: ".lemonlime-attachments/up-2/photo.heic" },
              { id: "up-3", name: "notes.txt", size: 10, path: ".lemonlime-attachments/up-3/notes.txt" },
            ],
          },
        ],
      ]),
    );
    expect(user).toMatchObject({ files: ["shot.png", "photo.heic", "notes.txt"], images: [{ id: "up-1", name: "shot.png" }] });
  });
});

describe("collapsing long messages", () => {
  it("leaves short messages alone", () => {
    expect(collapseLongText("a\nb\nc")).toBeNull();
    expect(collapseLongText("x".repeat(500))).toBeNull();
  });

  it("keeps the start and end of many lines", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const c = collapseLongText(text)!;
    expect(c.head.split("\n")).toHaveLength(8);
    expect(c.head.startsWith("line 1\n")).toBe(true);
    expect(c.tail).toBe("line 38\nline 39\nline 40");
    expect(c.hiddenLines).toBe(29);
  });

  it("doesn't fold away just one or two lines", () => {
    expect(collapseLongText(Array.from({ length: 13 }, () => "x").join("\n"), { maxLines: 12 })).toBeNull();
  });

  it("cuts one very long line at spaces", () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    const c = collapseLongText(words)!;
    expect(c.head.length).toBeLessThanOrEqual(700);
    expect(c.head.endsWith(" ")).toBe(false);
    expect(words.startsWith(c.head)).toBe(true);
    expect(words.endsWith(c.tail)).toBe(true);
    expect(c.tail.startsWith("w")).toBe(true);
    expect(c.hiddenChars).toBeGreaterThan(1000);
  });
});

describe("the message list", () => {
  it("lists each sent message and the agent's answer to each turn", () => {
    const items = buildTimeline(
      timed([
        [0, { type: "user_message", text: "## Fix the **login** bug\nmore detail" }],
        [1, { type: "agent_message", text: "Looking.", partial: false }],
        [2, { type: "agent_message", text: "Fixed it in `auth.ts`.", partial: false }],
        [3, { type: "user_message", text: "thanks" }],
        [4, { type: "user_message", text: "now [the docs](https://example.org)" }],
        [5, { type: "agent_message", text: "- Updated the docs", partial: false }],
      ]),
      [{ clientMsgId: "p", text: "pending", at: "2026-01-01T00:10:00.000Z" }],
    );
    const toc = tocEntries(items);
    expect(toc.you.map(e => e.label)).toEqual(["Fix the login bug", "thanks", "now the docs"]);
    expect(toc.agent.map(e => e.label)).toEqual(["Fixed it in auth.ts.", "Updated the docs"]);
    expect(toc.agent[0]!.key).toBe("e3");
  });

  it("skips code fences and trims long first lines", () => {
    expect(tocLabel("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(tocLabel("x".repeat(200), 20)).toHaveLength(20);
  });
});

describe("shell commands", () => {
  it("knows shell tools and unwraps shell wrappers", () => {
    expect(commandOf("Bash", { command: "npm test", description: "Run tests" })).toBe("npm test");
    expect(commandOf("shell", { command: "/bin/zsh -lc 'git status && echo '\\''done'\\'''" })).toBe("git status && echo 'done'");
    expect(commandOf("shell", { command: 'bash -lc "echo \\"hi\\""' })).toBe('echo "hi"');
    expect(commandOf("shell", { command: ["ls", "-la"] })).toBe("ls -la");
    expect(commandOf("Read", { command: "x" })).toBeNull();
    expect(commandOf("Bash", {})).toBeNull();
  });

  it("reads the exit code from the event or Claude Code's first line, and cleans terminal codes", () => {
    expect(commandOutput("Exit code 2\nnot found\n")).toEqual({ text: "not found", exitCode: 2 });
    expect(commandOutput("ok\n", 0)).toEqual({ text: "ok", exitCode: 0 });
    expect(commandOutput("plain")).toEqual({ text: "plain", exitCode: null });
    expect(cleanTerminalText("\u001b[32mgreen\u001b[0m\n10%\r50%\r100%")).toBe("green\n100%");
  });

  it("shows the end of long output", () => {
    const text = Array.from({ length: 100 }, (_, i) => String(i)).join("\n");
    expect(terminalTail(text, 10)).toEqual({ shown: "90\n91\n92\n93\n94\n95\n96\n97\n98\n99", hiddenLines: 90 });
    expect(terminalTail("a\nb", 10).hiddenLines).toBe(0);
  });
});

describe("the New divider", () => {
  const items = buildTimeline(
    timed([
      [0, { type: "user_message", text: "one" }],
      [1, { type: "agent_message", text: "a", partial: false }],
      [2, { type: "user_message", text: "two" }],
      [3, { type: "agent_message", text: "b", partial: false }],
    ]),
  );
  it("goes above the first item the user hasn't seen", () => {
    expect(unreadIndex(items, 2)).toBe(2);
  });
  it("isn't shown when everything was seen, nothing was, or it would sit at the very top", () => {
    expect(unreadIndex(items, 4)).toBe(-1);
    expect(unreadIndex(items, undefined)).toBe(-1);
    expect(unreadIndex(items, 0)).toBe(-1);
  });
});

describe("standing warnings", () => {
  it("keep only the latest disk warning, and leave other notices alone", async () => {
    const { buildTimeline } = await import("../src/lib/timeline.ts");
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const items = buildTimeline([
      { threadId: "tl-test-1", seq: 1, at: at(0), type: "notice", code: "disk_low", message: "3 GB left" },
      { threadId: "tl-test-1", seq: 2, at: at(1), type: "notice", code: "other", message: "hello" },
      { threadId: "tl-test-1", seq: 3, at: at(2), type: "notice", code: "disk_low", message: "2 GB left" },
    ] as never);
    expect(items.map(i => (i.kind === "notice" ? i.message : i.kind))).toEqual(["hello", "2 GB left"]);
  });
});
