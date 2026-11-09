import { describe, expect, it } from "vitest";
import { keyedToast, threadToastChange, TOAST_REPEAT_MS } from "../src/lib/toasts.ts";
import { notificationId, notifyTargetOf } from "../src/lib/system.ts";

describe("keyed toasts", () => {
  it("shows the first, replaces with news, and drops a repeat within a moment", () => {
    expect(keyedToast(undefined, "Done", 0)).toBe("add");
    const showing = { at: 1000, text: "Done", open: true };
    expect(keyedToast(showing, "Done", 1000 + TOAST_REPEAT_MS - 1)).toBe("drop");
    expect(keyedToast(showing, "Done", 1000 + TOAST_REPEAT_MS)).toBe("replace");
    expect(keyedToast(showing, "Failed", 1001)).toBe("replace");
  });

  it("adds a new one once the last has closed", () => {
    expect(keyedToast({ at: 1000, text: "Done", open: false }, "Done", 1001)).toBe("add");
  });
});

describe("thread toasts", () => {
  it("offers Open thread once you've left the thread, and goes once you're back", () => {
    expect(threadToastChange({ visible: false, offersOpen: false, ownAction: false })).toBe("offer-open");
    expect(threadToastChange({ visible: true, offersOpen: true, ownAction: false })).toBe("close");
    expect(threadToastChange({ visible: true, offersOpen: false, ownAction: false })).toBe("keep");
    expect(threadToastChange({ visible: false, offersOpen: true, ownAction: false })).toBe("keep");
  });

  it("leaves a toast with its own button alone", () => {
    expect(threadToastChange({ visible: false, offersOpen: false, ownAction: true })).toBe("keep");
  });
});

describe("notifications about a thread", () => {
  it("gives each thread its own steady 32-bit number", () => {
    const a = notificationId("thr_abc");
    expect(notificationId("thr_abc")).toBe(a);
    expect(notificationId("thr_abd")).not.toBe(a);
    for (const id of ["", "x", "thr_0123456789abcdef"]) {
      const n = notificationId(id);
      expect(Number.isInteger(n) && n > 0 && n <= 2 ** 31 - 1).toBe(true);
    }
  });

  it("reads the thread back from a clicked notification", () => {
    expect(notifyTargetOf({ threadId: "t1", mode: "cloud" })).toEqual({ threadId: "t1", mode: "cloud" });
    expect(notifyTargetOf({ threadId: "t1", mode: "elsewhere" })).toBeNull();
    expect(notifyTargetOf({ mode: "local" })).toBeNull();
    expect(notifyTargetOf(null)).toBeNull();
  });
});
