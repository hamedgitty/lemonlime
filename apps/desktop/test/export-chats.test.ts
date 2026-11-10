import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { exportGapsLine, gatherThread, gatherThreads, parseHistory, personLabel, toJson, toMarkdown, type ExportSources } from "../src/lib/exportChats.ts";
import type { ThreadSummary } from "../src/lib/threads.ts";

const at = "2026-01-01T00:00:00.000Z";
const events = (list: NewEvent[], threadId = "thread-0001"): ThreadEvent[] => list.map((e, i) => ThreadEvent.parse({ ...e, threadId, at, seq: i + 1 }));
/** A conversation of `n` exchanges. */
const talk = (n: number, threadId = "thread-0001") =>
  events(
    Array.from({ length: n }, (_, i): NewEvent[] => [
      { type: "user_message", text: `question ${i + 1}` },
      { type: "agent_message", text: `answer ${i + 1}`, partial: false },
    ]).flat(),
    threadId,
  );
/** A runner's history file: one event per line. */
const file = (list: ThreadEvent[]) => list.map(e => JSON.stringify(e)).join("\n") + "\n";

const local = (o: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "local-0001",
  mode: "local",
  title: "Local work",
  agent: { kind: "claude-code" },
  repo: "/code/site",
  branch: "agent/local-0001",
  status: "offline",
  updatedAt: at,
  createdAt: at,
  ...o,
});
const cloud = (o: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "thread-0001",
  mode: "cloud",
  title: "Fix tests",
  agent: { kind: "codex" },
  repo: "https://example.com/team/site.git",
  branch: "agent/thread-0001",
  status: "paused",
  updatedAt: at,
  createdAt: at,
  ...o,
});

const nothingCached: ExportSources = { cached: () => [] };
/** A control plane holding these events, handing them out `size` at a time. */
const controlPlane = (all: ThreadEvent[], size = 100) => {
  const asked: number[] = [];
  const stored = async (_id: string, after: number) => {
    asked.push(after);
    const page = all.filter(e => e.seq > after).slice(0, size);
    return { events: page, more: after + page.length < all.length };
  };
  return { stored, asked };
};
const down = async (): Promise<never> => {
  throw new Error("Could not reach the control plane.");
};

describe("a thread on this computer whose messages the app no longer holds", () => {
  it("is exported from the file its runner keeps", async () => {
    const kept = talk(3, "local-0001");
    const out = await gatherThread(local(), { ...nothingCached, kept: async () => file(kept) });
    expect(out.events).toEqual(kept);
    expect(out.note).toBeUndefined();
  });

  it("takes whichever copy reaches further into the conversation", async () => {
    const long = talk(4, "local-0001");
    const short = long.slice(0, 2);
    expect((await gatherThread(local(), { cached: () => short, kept: async () => file(long) })).events).toEqual(long);
    expect((await gatherThread(local(), { cached: () => long, kept: async () => file(short) })).events).toEqual(long);
    expect((await gatherThread(local(), { cached: () => long, kept: async () => null })).events).toEqual(long);
  });

  it("reads the runner's file up to a last line that was cut short", () => {
    const kept = talk(2, "local-0001");
    const torn = file(kept) + '{"type":"agent_message","text":"half a li';
    expect(parseHistory(torn)).toEqual(kept);
    expect(parseHistory("\n\n")).toEqual([]);
    expect(parseHistory("not a history file")).toEqual([]);
  });

  it("goes in the file with a line saying so when its messages are nowhere on this computer", async () => {
    const out = await gatherThread(local(), { ...nothingCached, kept: async () => null });
    expect(out.events).toEqual([]);
    expect(out.note).toBe("No messages were found for this thread on this computer.");
  });

  it("says why when the runner's file can't be read", async () => {
    const out = await gatherThread(local(), {
      ...nothingCached,
      kept: async () => {
        throw new Error("This thread's history is too big to read in one piece.");
      },
    });
    expect(out.events).toEqual([]);
    expect(out.note).toBe("This thread's messages couldn't be read from this computer: This thread's history is too big to read in one piece.");
  });

  it("still exports what the app kept when the runner's file can't be read", async () => {
    const cached = talk(1, "local-0001");
    const out = await gatherThread(local(), { cached: () => cached, kept: down });
    expect(out).toEqual({ thread: local(), events: cached });
  });

  it("is left to what the app kept when it runs on another machine, where its history is", async () => {
    const elsewhere = local({ machine: "build-box" });
    let asked = false;
    const kept = async () => {
      asked = true;
      return file(talk(2, "local-0001"));
    };
    const cached = talk(1, "local-0001");
    expect(await gatherThread(elsewhere, { cached: () => cached, kept })).toEqual({ thread: elsewhere, events: cached });
    const none = await gatherThread(elsewhere, { ...nothingCached, kept });
    expect(none.events).toEqual([]);
    expect(none.note).toBe("This thread runs on another machine and its messages aren't on this computer. Open it, then export again.");
    expect(asked).toBe(false);
  });
});

describe("a cloud thread that was never opened on this computer", () => {
  it("is exported from the control plane's stored history, page after page", async () => {
    const all = talk(5);
    const { stored, asked } = controlPlane(all, 4);
    const out = await gatherThread(cloud(), { ...nothingCached, stored });
    expect(out.events).toEqual(all);
    expect(out.note).toBeUndefined();
    expect(asked).toEqual([0, 4, 8]);
  });

  it("uses the app's own copy when that has later messages than the control plane has stored", async () => {
    const all = talk(3);
    const { stored } = controlPlane(all.slice(0, 2));
    expect(await gatherThread(cloud(), { cached: () => all, stored })).toEqual({ thread: cloud(), events: all });
  });

  it("falls back to what this computer kept when the control plane can't be reached, and says the latest may be missing", async () => {
    const cached = talk(2);
    const out = await gatherThread(cloud(), { cached: () => cached, stored: down });
    expect(out.events).toEqual(cached);
    expect(out.note).toBe(
      "The rest of this thread couldn't be fetched (Could not reach the control plane), so this is what this computer had. The latest messages may be missing.",
    );
  });

  it("stays in the file with the reason when its messages can't be had at all", async () => {
    const out = await gatherThread(cloud(), { ...nothingCached, stored: down });
    expect(out.events).toEqual([]);
    expect(out.note).toBe("This thread's messages couldn't be fetched: Could not reach the control plane.");
  });

  it("stays in the file when nobody is signed in", async () => {
    expect((await gatherThread(cloud(), nothingCached)).note).toBe("This thread's messages aren't on this computer. Sign in, then export again.");
    const cached = talk(1);
    const out = await gatherThread(cloud(), { cached: () => cached });
    expect(out.events).toEqual(cached);
    expect(out.note).toBe("You weren't signed in when this was exported, so this is what this computer had kept. The latest messages may be missing.");
  });

  it("says so when nothing is stored for it yet", async () => {
    const out = await gatherThread(cloud(), { ...nothingCached, stored: controlPlane([]).stored });
    expect(out).toEqual({ thread: cloud(), events: [], note: "No messages are stored for this thread yet." });
  });

  it("stops asking for a thread that never ends, and says its latest messages are missing", async () => {
    const asked: number[] = [];
    const endless = async (_id: string, after: number) => {
      asked.push(after);
      return { events: events([{ type: "agent_message", text: "more", partial: false }]).map(e => ({ ...e, seq: after + 1 })), more: true };
    };
    const out = await gatherThread(cloud(), { ...nothingCached, stored: endless });
    expect(asked.length).toBe(200);
    expect(out.events.length).toBe(200);
    expect(out.note).toBe("This thread is too long to fetch in one go, so its latest messages are missing.");
  });
});

describe("exporting several threads at once", () => {
  const mine = local();
  const theirs = cloud({ id: "thread-0002", title: "Broken" });
  const fine = cloud({ id: "thread-0003", title: "Fine" });
  const sources: ExportSources = {
    cached: () => [],
    kept: async () => file(talk(1, "local-0001")),
    stored: async (id, after) => {
      if (id === "thread-0002") throw new Error("Thread not found.");
      return controlPlane(talk(2, id)).stored(id, after);
    },
  };

  it("carries on past a thread that fails, keeping every thread in the file", async () => {
    const out = await gatherThreads([mine, theirs, fine], sources);
    expect(out.map(o => [o.thread.title, o.events.length, o.note])).toEqual([
      ["Local work", 2, undefined],
      ["Broken", 0, "This thread's messages couldn't be fetched: Thread not found."],
      ["Fine", 4, undefined],
    ]);
  });

  it("tells the person afterwards what the file is missing", async () => {
    const out = await gatherThreads([mine, theirs, fine], sources);
    expect(exportGapsLine(out)).toBe("1 thread is in the file without its messages. The file says why.");
    expect(exportGapsLine(out.filter(o => !o.note))).toBeNull();
    expect(exportGapsLine([out[1]!])).toBe("This thread is in the file without its messages. The file says why.");
    const partial = { thread: fine, events: talk(1, "thread-0003"), note: "The latest messages may be missing." };
    expect(exportGapsLine([out[1]!, { ...out[1]! }, partial])).toBe(
      "2 threads are in the file without their messages. 1 thread may be missing its latest messages. The file says why for each.",
    );
    expect(exportGapsLine([partial, { ...partial }])).toBe("2 threads may be missing their latest messages. The file says why for each.");
  });
});

describe("the exported file", () => {
  const when = (iso: string) => iso.slice(0, 10);
  const history = events([
    { type: "user_message", text: "Fix the build" },
    { type: "agent_message", text: "Looking", partial: true },
    { type: "agent_message", text: " into it.", partial: true },
    { type: "agent_message", text: "Looking into it.", partial: false },
    { type: "tool_call", callId: "c1", name: "Bash", input: { command: "pnpm test" } },
    { type: "status_change", from: "running", to: "idle" },
    { type: "user_message", text: "Two tests fail.\n\nBoth are in sum.test.js.", from: "subagent" },
    { type: "agent_message", text: "Fixed.", partial: false },
    { type: "status_change", from: "running", to: "idle" },
    { type: "user_message", text: "Continue where\nyou left off.", from: "runner" },
    { type: "error", message: "The agent stopped.", fatal: false },
  ]);

  it("puts each thread's messages under its title, with streamed replies in one piece", () => {
    const md = toMarkdown([{ thread: cloud(), events: history }], { exportedAt: at, when });
    expect(md).toContain("# LemonLime chats\n\nExported 2026-01-01.\n");
    expect(md).toContain("## Fix tests\n\nCodex, site, branch `agent/thread-0001`, cloud.\n");
    expect(md).toContain("**You** (2026-01-01)\n\nFix the build\n");
    expect(md.match(/\*\*Codex\*\*\n\nLooking into it\.\n/g)).toHaveLength(1);
    expect(md).not.toContain("**Codex**\n\nLooking\n");
    expect(md).toContain("> Used Bash\n");
    expect(md).toContain("> Error: The agent stopped.\n");
  });

  it("never puts a subagent's report or a message LemonLime sent down to the person", () => {
    const md = toMarkdown([{ thread: cloud(), events: history }], { exportedAt: at, when });
    expect(md).toContain("**Subagent report** (2026-01-01)\n\nTwo tests fail.\n\nBoth are in sum.test.js.\n");
    expect(md).toContain("> Sent by LemonLime (2026-01-01): Continue where you left off.\n");
    expect(md.match(/\*\*You\*\*/g)).toHaveLength(1);
  });

  it("says who a typed message may be from when other workspace members can take part", () => {
    expect(personLabel(local())).toBe("You");
    expect(personLabel(cloud())).toBe("You");
    expect(personLabel(cloud({ sharing: "read-only" }))).toBe("A workspace member");
    expect(personLabel(cloud({ sharing: "shared-with-you" }))).toBe("You or a workspace member");
    expect(personLabel(cloud({ sharing: "shared-by-you" }))).toBe("You or a workspace member");
    const md = toMarkdown([{ thread: cloud({ sharing: "read-only" }), events: talk(1) }], { exportedAt: at, when });
    expect(md).toContain("**A workspace member** (2026-01-01)\n\nquestion 1\n");
    expect(md).not.toContain("**You**");
  });

  it("says under a thread's title why its messages are missing", () => {
    const note = "No messages were found for this thread on this computer.";
    const md = toMarkdown([{ thread: local(), events: [], note }], { exportedAt: at, when });
    expect(md).toContain(
      "## Local work\n\nClaude Code, site, branch `agent/local-0001`, this computer.\n\n> No messages were found for this thread on this computer.\n",
    );
    const json = JSON.parse(
      toJson(
        [
          { thread: local(), events: [], note },
          { thread: cloud(), events: talk(1) },
        ],
        at,
      ),
    );
    expect(json.exportedAt).toBe(at);
    expect(json.threads[0]).toMatchObject({ thread: { id: "local-0001" }, events: [], note });
    expect(json.threads[1].events).toHaveLength(2);
    expect(json.threads[1].note).toBeUndefined();
  });
});
