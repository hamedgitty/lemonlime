import { describe, expect, it } from "vitest";
import { isUnread, rowGlyph, waitingCount, type RowStateInput } from "../src/lib/threadState.ts";

const base: RowStateInput = {
  status: "idle",
  waiting: 0,
  latestSeq: 10,
  seenSeq: 10,
  createdAt: "2026-11-01T00:00:00.000Z",
  unreadSince: "2026-10-01T00:00:00.000Z",
  markedUnread: false,
  draft: false,
  selected: false,
};

describe("unread", () => {
  it("is work that finished after you last looked", () => {
    expect(isUnread(base)).toBe(false);
    expect(isUnread({ ...base, latestSeq: 14 })).toBe(true);
    // Still working: not finished yet.
    expect(isUnread({ ...base, latestSeq: 14, status: "running" })).toBe(false);
    // Open on screen: you're looking at it.
    expect(isUnread({ ...base, latestSeq: 14, selected: true })).toBe(false);
    expect(isUnread({ ...base, latestSeq: 14, status: "offline" })).toBe(true);
  });

  it("counts threads from before tracking began as read, and newer unseen ones as unread", () => {
    const fresh = { ...base, seenSeq: undefined };
    expect(isUnread({ ...fresh, createdAt: "2026-09-01T00:00:00.000Z" })).toBe(false);
    expect(isUnread(fresh)).toBe(true);
    expect(isUnread({ ...fresh, unreadSince: "" })).toBe(false);
    expect(isUnread({ ...fresh, latestSeq: 0 })).toBe(false);
  });

  it("can be marked by hand, even while open", () => {
    expect(isUnread({ ...base, markedUnread: true })).toBe(true);
    expect(isUnread({ ...base, markedUnread: true, selected: true })).toBe(true);
  });
});

describe("row status mark priority", () => {
  it("unread error > waiting > working > finished-unread > draft > seen failure", () => {
    const all = { ...base, status: "failed" as const, latestSeq: 20, waiting: 1, draft: true };
    expect(rowGlyph(all)).toBe("error");
    expect(rowGlyph({ ...all, seenSeq: 20 })).toBe("waiting");
    expect(rowGlyph({ ...all, status: "running" })).toBe("waiting");
    expect(rowGlyph({ ...all, status: "running", waiting: 0 })).toBe("working");
    expect(rowGlyph({ ...all, status: "provisioning", waiting: 0 })).toBe("working");
    expect(rowGlyph({ ...all, status: "idle", waiting: 0 })).toBe("unread");
    expect(rowGlyph({ ...all, status: "idle", waiting: 0, seenSeq: 20 })).toBe("draft");
    expect(rowGlyph({ ...all, waiting: 0, seenSeq: 20, draft: false })).toBe("failed");
    expect(rowGlyph(base)).toBeNull();
  });

  it("counts threads waiting for you, leaving archived ones out", () => {
    expect(
      waitingCount(
        [
          { id: "a", waiting: 2 },
          { id: "b", waiting: 0 },
          { id: "c", waiting: 1 },
        ],
        { c: "2026-11-01T00:00:00.000Z" },
      ),
    ).toBe(1);
  });
});
