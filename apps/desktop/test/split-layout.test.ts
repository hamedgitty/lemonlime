import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PANES,
  closePane,
  dropZoneAt,
  evenSplit,
  focusPane,
  layoutBoxes,
  openThreadIds,
  panes,
  parseLayout,
  replacePane,
  resizeSplit,
  restoreLayout,
  showThread,
  singlePane,
  splitPane,
  toggleMaximise,
  type PaneContent,
  type SplitLayout,
  type SplitNode,
} from "../src/lib/splitLayout.ts";
import { loadSplitLayout, saveSplitLayout } from "../src/lib/storage.ts";
import { SHORTCUTS, keysFor } from "../src/lib/shortcuts.ts";

const t = (id: string, mode: "local" | "cloud" = "local"): Extract<PaneContent, { kind: "thread" }> => ({ kind: "thread", mode, id });
const ids = (l: SplitLayout) => panes(l).map(p => (p.content.kind === "thread" ? p.content.id : "new"));
const root = (l: SplitLayout) => l.root as SplitNode;

/** a | b, with b split into b over c. */
function three(): SplitLayout {
  let l = singlePane(t("a"), "p1");
  l = splitPane(l, "p1", "right", t("b"), "p2");
  return splitPane(l, "p2", "bottom", t("c"), "p3");
}

describe("splitting", () => {
  it("puts the new pane on the asked side and makes it active", () => {
    const l = splitPane(singlePane(t("a"), "p1"), "p1", "left", t("b"), "p2");
    expect(ids(l)).toEqual(["b", "a"]);
    expect(root(l).dir).toBe("row");
    expect(root(l).sizes).toEqual([0.5, 0.5]);
    expect(l.active).toBe("p2");
  });

  it("adds to an existing split going the same way instead of nesting", () => {
    let l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    l = splitPane(l, "p2", "right", t("c"), "p3");
    expect(root(l).children).toHaveLength(3);
    expect(root(l).sizes).toEqual([0.5, 0.25, 0.25]);
    expect(ids(l)).toEqual(["a", "b", "c"]);
  });

  it("nests a split going the other way", () => {
    const l = three();
    expect(root(l).dir).toBe("row");
    const right = root(l).children[1] as SplitNode;
    expect(right.dir).toBe("column");
    expect(ids(l)).toEqual(["a", "b", "c"]);
  });

  it("stops at the pane limit", () => {
    let l = singlePane(t("t0"), "p0");
    for (let i = 1; i < MAX_PANES + 3; i++) l = splitPane(l, l.active, i % 2 ? "right" : "bottom", t(`t${i}`), `p${i}`);
    expect(panes(l)).toHaveLength(MAX_PANES);
  });

  it("moves a thread that's already open instead of showing it twice", () => {
    const l = splitPane(three(), "p1", "bottom", t("c"), "p4");
    expect(ids(l)).toEqual(["a", "c", "b"]);
    expect(openThreadIds(l).size).toBe(3);
  });

  it("does nothing when a pane is split with its own thread", () => {
    const l = three();
    expect(splitPane(l, "p2", "left", t("b"), "p9")).toBe(l);
  });
});

describe("closing", () => {
  it("gives the space to the siblings and collapses single-child splits", () => {
    const l = closePane(three(), "p3")!;
    expect(ids(l)).toEqual(["a", "b"]);
    expect(root(l).dir).toBe("row");
    expect(root(l).children.every(c => c.type === "pane")).toBe(true);
    expect(root(l).sizes).toEqual([0.5, 0.5]);
  });

  it("shares a closed pane's size in proportion", () => {
    let l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    l = splitPane(l, "p2", "right", t("c"), "p3"); // .5 .25 .25
    l = closePane(l, "p1")!;
    expect(root(l).sizes).toEqual([0.5, 0.5]);
  });

  it("merges a split into its parent when they go the same way", () => {
    // a | (b / (c | d)) → close b → a | c | d
    let l = three();
    l = splitPane(l, "p3", "right", t("d"), "p4");
    l = closePane(l, "p2")!;
    expect(root(l).dir).toBe("row");
    expect(root(l).children).toHaveLength(3);
    expect(root(l).sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("moves the keyboard to a neighbour and clears a maximised pane", () => {
    let l = toggleMaximise(three(), "p3");
    l = closePane(l, "p3")!;
    expect(l.active).toBe("p2");
    expect(l.maximised).toBeNull();
  });

  it("returns null once the last pane is closed", () => {
    expect(closePane(singlePane(t("a"), "p1"), "p1")).toBeNull();
  });
});

describe("focus, replace and maximise", () => {
  it("opens a thread in the active pane, or focuses the pane that has it", () => {
    let l = focusPane(three(), "p1");
    l = showThread(l, t("c"));
    expect(l.active).toBe("p3");
    l = showThread(l, t("z"));
    expect(ids(l)).toEqual(["a", "b", "z"]);
    expect(l.active).toBe("p3");
  });

  it("replacing with a thread from another pane moves it", () => {
    const l = replacePane(three(), "p1", t("b"));
    expect(ids(l)).toEqual(["b", "c"]);
    expect(l.active).toBe("p1");
  });

  it("maximises and restores", () => {
    let l = toggleMaximise(three(), "p2");
    expect(l.maximised).toBe("p2");
    expect(l.active).toBe("p2");
    // Focusing another pane while maximised shows that one instead.
    l = focusPane(l, "p1");
    expect(l.maximised).toBe("p1");
    l = toggleMaximise(l, "p1");
    expect(l.maximised).toBeNull();
  });
});

describe("resizing", () => {
  it("moves the divider by pixels", () => {
    const l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    const r = resizeSplit(l, root(l).id, 0, 100, 1000, 200);
    expect(root(r).sizes[0]).toBeCloseTo(0.6);
    expect(root(r).sizes[1]).toBeCloseTo(0.4);
  });

  it("keeps each side at least its minimum, counting nested panes", () => {
    // a | (b | c merged) — three across, 1200px, 300px min.
    let l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    l = splitPane(l, "p2", "bottom", t("c"), "p3");
    l = splitPane(l, "p3", "right", t("d"), "p4"); // right side is b over (c | d): two wide at its narrowest
    const r = resizeSplit(l, root(l).id, 0, 10_000, 1200, 300);
    expect(root(r).sizes[1]! * 1200).toBeCloseTo(600);
    const s = resizeSplit(l, root(l).id, 0, -10_000, 1200, 300);
    expect(root(s).sizes[0]! * 1200).toBeCloseTo(300);
  });

  it("leaves it alone when there's no room for both minimums", () => {
    const l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    expect(resizeSplit(l, root(l).id, 0, 50, 400, 300)).toBe(l);
  });

  it("evens a split out again", () => {
    const l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    const r = evenSplit(resizeSplit(l, root(l).id, 0, 100, 1000, 100), root(l).id);
    expect(root(r).sizes).toEqual([0.5, 0.5]);
  });
});

describe("geometry", () => {
  it("places panes and dividers", () => {
    const { panes: boxes, dividers } = layoutBoxes(three());
    expect(boxes.find(b => b.id === "p1")!.box).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(boxes.find(b => b.id === "p3")!.box).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(dividers).toHaveLength(2);
    expect(dividers.map(d => [d.dir, d.at])).toEqual([
      ["row", 0.5],
      ["column", 0.5],
    ]);
  });
});

describe("drop zones", () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  it("finds the nearest edge within the band, else the middle", () => {
    expect(dropZoneAt(rect, 110, 150)).toBe("left");
    expect(dropZoneAt(rect, 490, 150)).toBe("right");
    expect(dropZoneAt(rect, 300, 60)).toBe("top");
    expect(dropZoneAt(rect, 300, 245)).toBe("bottom");
    expect(dropZoneAt(rect, 300, 150)).toBe("center");
  });
  it("picks the closer edge near a corner", () => {
    // 5% from the left, 10% from the top.
    expect(dropZoneAt(rect, 120, 70)).toBe("left");
  });
  it("is always the middle when the layout is full", () => {
    expect(dropZoneAt(rect, 110, 150, false)).toBe("center");
  });
});

describe("keeping the layout", () => {
  it("survives a round trip", () => {
    const l = toggleMaximise(three(), "p2");
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });

  it("turns away broken data", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout({ root: { type: "split", id: "s", dir: "row", children: [], sizes: [] }, active: "x" })).toBeNull();
    const dupe = {
      root: { type: "split", id: "s", dir: "row", children: [singlePane(t("a"), "p").root, singlePane(t("b"), "p").root], sizes: [0.5, 0.5] },
      active: "p",
    };
    expect(parseLayout(dupe)).toBeNull();
    const badSizes = {
      root: { type: "split", id: "s", dir: "row", children: [singlePane(t("a"), "p").root, singlePane(t("b"), "q").root], sizes: [1] },
      active: "p",
    };
    expect(parseLayout(badSizes)).toBeNull();
  });

  it("drops repeats and fixes a missing active pane", () => {
    const raw = {
      root: {
        type: "split",
        id: "s",
        dir: "row",
        children: [singlePane(t("a"), "p").root, singlePane(t("a"), "q").root, singlePane(t("b"), "r").root],
        sizes: [0.2, 0.3, 0.5],
      },
      active: "gone",
      maximised: "gone",
    };
    const l = parseLayout(raw)!;
    expect(ids(l)).toEqual(["a", "b"]);
    expect(l.active).toBe("p");
    expect(l.maximised).toBeNull();
    expect(root(l).sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("drops threads that no longer exist when restoring", () => {
    const l = splitPane(three(), "p3", "right", t("cloudy", "cloud"), "p4");
    const restored = restoreLayout(JSON.parse(JSON.stringify(l)), c => (c.mode === "cloud" ? undefined : c.id !== "b"))!;
    // b is gone; the cloud thread can't be checked yet, so it stays.
    expect(ids(restored)).toEqual(["a", "c", "cloudy"]);
  });

  it("gives up on the split when only one pane is left", () => {
    const l = splitPane(singlePane(t("a"), "p1"), "p1", "right", t("b"), "p2");
    expect(restoreLayout(l, c => c.id === "a")).toBeNull();
  });

  describe("in local storage", () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      store.clear();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };
    });
    afterEach(() => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it("saves, loads and forgets", () => {
      const l = three();
      saveSplitLayout(l);
      expect(restoreLayout(loadSplitLayout(), () => true)).toEqual(l);
      saveSplitLayout(null);
      expect(loadSplitLayout()).toBeUndefined();
    });
  });
});

describe("split shortcuts", () => {
  it("don't clash with any other default shortcut", () => {
    const keys = SHORTCUTS.map(s => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keysFor("split-right", {})).not.toBe(keysFor("toggle-sidebar", {}));
  });
});
