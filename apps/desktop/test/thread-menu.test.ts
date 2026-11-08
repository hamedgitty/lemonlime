import { describe, expect, it } from "vitest";
import { ThreadEvent, type NewEvent } from "@lemonlime/protocol";
import { childRowKey, forkPrompt, threadMenuGroups, type ThreadMenuId, type ThreadMenuInput } from "../src/lib/threadMenu.ts";

const ALL: ThreadMenuId[] = ["rename", "pin", "unread", "split", "fork", "open-folder", "pull-request", "compact", "move", "archive", "remove"];

const base: ThreadMenuInput = { mode: "local", pinned: false, unread: false, archived: false, can: new Set(ALL), pullRequest: "view" };
const ids = (i: ThreadMenuInput) => threadMenuGroups(i).map(g => g.map(e => e.id));
const labels = (i: ThreadMenuInput) => threadMenuGroups(i).flatMap(g => g.map(e => e.label));

describe("thread actions menu", () => {
  it("groups everything a local thread can do, with removing last", () => {
    expect(ids(base)).toEqual([
      ["rename", "pin", "unread"],
      ["split", "fork"],
      ["copy-name", "copy-branch"],
      ["open-folder", "pull-request"],
      ["compact", "move"],
      ["archive", "remove"],
    ]);
    const last = threadMenuGroups(base).at(-1)!.at(-1)!;
    expect(last).toMatchObject({ id: "remove", danger: true });
  });

  it("only offers what the place can do; copying always", () => {
    // The sidebar: no live session, so no compact or move.
    const sidebar = ids({ ...base, can: new Set<ThreadMenuId>(["rename", "pin", "archive"]) });
    expect(sidebar).toEqual([["rename", "pin"], ["copy-name", "copy-branch"], ["archive"]]);
    expect(ids({ ...base, can: new Set() })).toEqual([["copy-name", "copy-branch"]]);
  });

  it("words items for the thread's state", () => {
    expect(labels({ ...base, pinned: true, unread: true })).toEqual(expect.arrayContaining(["Unpin", "Mark as read"]));
    expect(labels(base)).toEqual(expect.arrayContaining(["Pin to top", "Mark as unread", "Open folder", "View pull request", "Move to the cloud"]));
    expect(labels({ ...base, editor: true, pullRequest: "open" })).toEqual(expect.arrayContaining(["Open in editor", "Open pull request"]));
  });

  it("leaves out a pull request it doesn't know of, and splitting a thread already in the split", () => {
    expect(labels({ ...base, pullRequest: null })).not.toContain("View pull request");
    expect(ids({ ...base, inSplit: true }).flat()).not.toContain("split");
  });

  it("keeps cloud threads to what works there", () => {
    const cloud = { ...base, mode: "cloud" as const };
    const flat = ids(cloud).flat();
    expect(flat).not.toContain("open-folder");
    expect(flat).not.toContain("remove");
    expect(labels(cloud)).toContain("Move to this computer");
  });

  it("offers an archived thread little more than unarchiving it", () => {
    const archived = { ...base, archived: true };
    expect(ids(archived).flat()).toEqual(["rename", "fork", "copy-name", "copy-branch", "open-folder", "pull-request", "archive", "remove"]);
    expect(labels(archived)).toContain("Unarchive");
  });

  it("shows unusable items disabled, with why", () => {
    const groups = threadMenuGroups({ ...base, disabled: { compact: "", "open-folder": "This computer only" } });
    const flat = groups.flat();
    expect(flat.find(e => e.id === "compact")).toEqual({ id: "compact", label: "Compact conversation", disabled: true });
    expect(flat.find(e => e.id === "open-folder")).toMatchObject({ disabled: true, hint: "This computer only" });
    expect(flat.find(e => e.id === "rename")?.disabled).toBeUndefined();
  });
});

const at = "2026-11-08T12:00:00.000Z";
const ev = (seq: number, e: NewEvent) => ThreadEvent.parse({ ...e, threadId: "thread-1", seq, at });

describe("forking a thread", () => {
  it("starts with what the thread was about and where it got to", () => {
    const events = [
      ev(1, { type: "user_message", text: "Add dark mode" }),
      ev(2, { type: "agent_message", text: "Working", partial: true }),
      ev(3, { type: "agent_message", text: "Added a theme switch.\nTests pass.", partial: false }),
    ];
    const text = forkPrompt({ title: "Dark mode", branch: "agent/t1" }, events);
    expect(text).toContain("“Dark mode”");
    expect(text).toContain("agent/t1");
    expect(text).toContain("> Add dark mode");
    expect(text).toContain("> Added a theme switch.\n> Tests pass.");
    expect(text).not.toContain("Working");
  });

  it("works without any history, and clips long messages", () => {
    expect(forkPrompt({ title: "T", branch: "b" }, [])).not.toContain(">");
    const long = forkPrompt({ title: "T", branch: "b" }, [ev(1, { type: "user_message", text: "x".repeat(5000) })]);
    expect(long.length).toBeLessThan(1500);
    expect(long).toContain("…");
  });
});

describe("opening a thread at a subagent", () => {
  it("finds the row of the call that started it", () => {
    const events = [ev(4, { type: "tool_call", callId: "call-1", name: "Task", input: { description: "Look around" } })];
    expect(childRowKey(events, "call-1")).toBe("e4");
    expect(childRowKey(events, "other")).toBeNull();
  });
});
