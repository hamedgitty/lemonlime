import { describe, expect, it } from "vitest";
import { announcement, freshAnnouncements, REPEAT_MS } from "../src/lib/announce.ts";

describe("screen reader announcements", () => {
  it("says what changed in a few words", () => {
    expect(announcement("finished", "Fix login")).toBe("“Fix login” finished.");
    expect(announcement("failed", "Fix login")).toBe("“Fix login” failed.");
    expect(announcement("needs-you", "  ")).toBe("A thread needs you.");
  });

  it("says each change once", () => {
    const said = new Map<string, number>();
    expect(freshAnnouncements(["A finished.", "B failed.", "A finished."], said, 0)).toEqual(["A finished.", "B failed."]);
    expect(freshAnnouncements(["A finished."], said, REPEAT_MS - 1)).toEqual([]);
    // A later change in the same words is news again.
    expect(freshAnnouncements(["A finished."], said, REPEAT_MS)).toEqual(["A finished."]);
  });
});
