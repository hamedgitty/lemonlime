import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLD_PAST, SIDEBAR, clampWidth, dragWidth, loadFolded, loadWidth, saveFolded, saveWidth } from "../src/lib/sideWidth.ts";

describe("side column widths", () => {
  it("keeps a dragged width inside the bounds", () => {
    expect(dragWidth(288, 40, SIDEBAR, true)).toBe(328);
    expect(dragWidth(288, 1000, SIDEBAR, true)).toBe(SIDEBAR.max);
    expect(dragWidth(288, -80, SIDEBAR, true)).toBe(SIDEBAR.min);
    expect(clampWidth(300.4, SIDEBAR)).toBe(300);
  });

  it("folds away only when dragged well past the narrowest width, and only if it can", () => {
    const toFold = SIDEBAR.min - FOLD_PAST - 1 - 288;
    expect(dragWidth(288, toFold, SIDEBAR, true)).toBeNull();
    expect(dragWidth(288, toFold, SIDEBAR, false)).toBe(SIDEBAR.min);
    expect(dragWidth(288, SIDEBAR.min - FOLD_PAST - 288, SIDEBAR, true)).toBe(SIDEBAR.min);
  });

  describe("remembered on this computer", () => {
    const data = new Map<string, string>();
    beforeEach(() => {
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      };
    });
    afterEach(() => {
      data.clear();
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it("starts at the default and brings back a saved width, clamped", () => {
      expect(loadWidth("w", SIDEBAR)).toBe(SIDEBAR.default);
      saveWidth("w", 350);
      expect(loadWidth("w", SIDEBAR)).toBe(350);
      saveWidth("w", 9000);
      expect(loadWidth("w", SIDEBAR)).toBe(SIDEBAR.max);
      data.set("w", "nonsense");
      expect(loadWidth("w", SIDEBAR)).toBe(SIDEBAR.default);
    });

    it("remembers whether a list is folded", () => {
      expect(loadFolded("f")).toBe(false);
      saveFolded("f", true);
      expect(loadFolded("f")).toBe(true);
      saveFolded("f", false);
      expect(data.has("f")).toBe(false);
    });
  });
});
