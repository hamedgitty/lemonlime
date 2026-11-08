import { describe, expect, it } from "vitest";
import { GROUP_ROWS, groupThreads, moveGroup, orderGroups, toggleKey, groupRows } from "../src/lib/sidebarGroups.ts";
import type { ThreadSummary } from "../src/lib/threads.ts";

const thread = (id: string, repo: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  mode: "local",
  title: id,
  agent: { kind: "claude-code" },
  repo,
  branch: `agent/${id}`,
  status: "idle",
  updatedAt: "2026-11-08T10:00:00.000Z",
  createdAt: "2026-11-08T09:00:00.000Z",
  ...extra,
});

describe("sidebar groups", () => {
  it("groups by project with pinned on top, and knows each project's folder", () => {
    const groups = groupThreads(
      [thread("a", "/code/app"), thread("b", "https://github.com/me/app", { mode: "cloud" }), thread("c", "/code/site"), thread("d", "/code/site")],
      { organize: "project", pinned: ["d"] },
    );
    expect(groups.map(g => [g.key, g.threads.map(t => t.id)])).toEqual([
      ["pinned", ["d"]],
      ["project:app", ["a", "b"]],
      ["project:site", ["c"]],
    ]);
    expect(groups[1]!.project).toEqual({ mode: "local", path: "/code/app" });
  });

  it("prefers this computer's folder over a cloud copy or another machine's", () => {
    const [g] = groupThreads(
      [thread("a", "https://github.com/me/app", { mode: "cloud" }), thread("b", "/srv/app", { machine: "m1" }), thread("c", "/code/app")],
      { organize: "project", pinned: [] },
    );
    expect(g!.project).toEqual({ mode: "local", path: "/code/app" });
    const [cloudOnly] = groupThreads([thread("a", "https://github.com/me/app", { mode: "cloud" })], { organize: "project", pinned: [] });
    expect(cloudOnly!.project).toEqual({ mode: "cloud", url: "https://github.com/me/app" });
  });

  it("groups by place and by agent under keys of their own", () => {
    const list = [thread("a", "/x"), thread("b", "/y", { mode: "cloud" }), thread("c", "/z", { machine: "m1", agent: { kind: "codex" } })];
    const place = groupThreads(list, { organize: "place", pinned: [], machineName: () => "Studio" });
    expect(place.map(g => [g.key, g.label])).toEqual([
      ["place:local", "On this computer"],
      ["place:cloud", "Cloud"],
      ["place:machine:m1", "On Studio"],
    ]);
    expect(groupThreads(list, { organize: "agent", pinned: [] }).map(g => g.key)).toEqual(["agent:claude-code", "agent:codex"]);
  });

  it("keeps the dragged order, with new groups after and pinned first", () => {
    const groups = groupThreads([thread("a", "/a"), thread("b", "/b"), thread("c", "/c"), thread("p", "/p")], { organize: "project", pinned: ["p"] });
    expect(orderGroups(groups, ["project:c", "project:a"]).map(g => g.key)).toEqual(["pinned", "project:c", "project:a", "project:b"]);
  });

  it("moves a group, keeping keys saved for groups not showing", () => {
    const shown = ["project:a", "project:b", "project:c"];
    expect(moveGroup(["project:old"], shown, "project:a", 2)).toEqual(["project:b", "project:c", "project:a", "project:old"]);
    expect(moveGroup([], shown, "project:c", 0)).toEqual(["project:c", "project:a", "project:b"]);
    expect(moveGroup([], shown, "project:a", 99)).toEqual(["project:b", "project:c", "project:a"]);
    // Pinned and groups not showing don't move.
    expect(moveGroup(["x"], shown, "pinned", 0)).toEqual(["x"]);
    expect(moveGroup(["x"], shown, "project:z", 0)).toEqual(["x"]);
  });

  it("folds a group away and back", () => {
    expect(toggleKey([], "project:a")).toEqual(["project:a"]);
    expect(toggleKey(["project:a", "project:b"], "project:a")).toEqual(["project:b"]);
  });
});

describe("show more", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));

  it(`shows the first ${GROUP_ROWS}, then how many more there are`, () => {
    const { shown, hidden } = groupRows(rows(12), { expanded: false, selectedId: null });
    expect(shown.map(t => t.id)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(hidden).toBe(7);
  });

  it("shows everything once expanded, or when only one more would hide", () => {
    expect(groupRows(rows(12), { expanded: true, selectedId: null })).toMatchObject({ hidden: 0 });
    expect(groupRows(rows(12), { expanded: true, selectedId: null }).shown).toHaveLength(12);
    expect(groupRows(rows(GROUP_ROWS + 1), { expanded: false, selectedId: null })).toMatchObject({ hidden: 0 });
    expect(groupRows(rows(3), { expanded: false, selectedId: null }).shown).toHaveLength(3);
  });

  it("never hides the open thread", () => {
    const { shown, hidden } = groupRows(rows(12), { expanded: false, selectedId: "t9" });
    expect(shown.map(t => t.id)).toEqual(["t0", "t1", "t2", "t3", "t4", "t9"]);
    expect(hidden).toBe(6);
  });
});
