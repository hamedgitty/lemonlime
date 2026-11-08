import { describe, expect, it } from "vitest";
import type { ChildWork } from "@lemonlime/protocol";
import { childrenSummary, CHILDREN_KEPT, gridCells, settled, withChildren } from "../src/lib/children.ts";

const child = (id: string, state: ChildWork["state"], title = id): ChildWork => ({
  id,
  title,
  state,
  source: "agent",
  parentId: null,
  startedAt: "2026-11-08T10:00:00.000Z",
});

describe("subagents in the sidebar", () => {
  it("keeps each thread's latest subagents, and drops a thread with none", () => {
    const one = withChildren({}, "t1", [child("a", "running"), child("b", "done")]);
    expect(one).toEqual({
      t1: [
        { id: "a", title: "a", state: "running" },
        { id: "b", title: "b", state: "done" },
      ],
    });
    // Nothing changed: the same object, so nothing re-renders or saves.
    expect(withChildren(one, "t1", [child("a", "running"), child("b", "done")])).toBe(one);
    expect(withChildren(one, "t1", [child("a", "done"), child("b", "done")]).t1![0]!.state).toBe("done");
    expect(withChildren(one, "t1", [])).toEqual({});
    expect(withChildren({}, "t1", [])).toEqual({});
    const many = withChildren(
      {},
      "t2",
      Array.from({ length: CHILDREN_KEPT + 7 }, (_, i) => child(`c${i}`, "done")),
    );
    expect(many.t2).toHaveLength(CHILDREN_KEPT);
    expect(many.t2!.at(-1)!.id).toBe(`c${CHILDREN_KEPT + 6}`);
  });

  it("counts subagents of a stopped runner as stopped", () => {
    const list = withChildren({}, "t", [child("a", "running"), child("b", "waiting"), child("c", "done")]).t!;
    expect(settled(list, true).map(c => c.state)).toEqual(["running", "waiting", "done"]);
    expect(settled(list, false).map(c => c.state)).toEqual(["failed", "failed", "done"]);
  });

  it("lays out the grid in a steady order with a count for the rest", () => {
    const list = withChildren({}, "t", [child("f", "failed"), child("r", "running"), child("d", "done"), child("w", "waiting")]).t!;
    expect(gridCells(list).cells.map(c => c.id)).toEqual(["d", "r", "w", "f"]);
    expect(gridCells(list, 2)).toMatchObject({ more: 2 });
    expect(childrenSummary(list)).toBe("4 subagents: 1 done, 1 running, 1 waiting, 1 failed");
    expect(childrenSummary(list.slice(0, 1))).toBe("1 subagent: 1 failed");
  });
});
