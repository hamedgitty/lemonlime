import { describe, expect, it } from "vitest";
import { isValidTimeZone, nextRun, parseSchedule } from "../src/index.ts";

const at = (iso: string) => new Date(iso);

describe("schedules", () => {
  it("finds the next time in UTC", () => {
    expect(nextRun("*/15 * * * *", at("2026-11-07T10:07:30Z"))?.toISOString()).toBe("2026-11-07T10:15:00.000Z");
    expect(nextRun("0 9 * * 1-5", at("2026-11-07T10:00:00Z"))?.toISOString()).toBe("2026-11-09T09:00:00.000Z"); // Sat → Mon
    expect(nextRun("30 2 1 * *", at("2026-11-07T00:00:00Z"))?.toISOString()).toBe("2026-12-01T02:30:00.000Z");
    expect(nextRun("0 0 29 2 *", at("2026-03-01T00:00:00Z"))?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(nextRun("0 12 * * 7", at("2026-11-07T12:00:00Z"))?.toISOString()).toBe("2026-11-08T12:00:00.000Z"); // 7 = Sunday
  });

  it("uses the automation's own time zone, across clock changes", () => {
    // 9:00 in London is 09:00Z in winter and 08:00Z in summer.
    expect(nextRun("0 9 * * *", at("2026-11-07T12:00:00Z"), "Europe/London")?.toISOString()).toBe("2026-11-08T09:00:00.000Z");
    expect(nextRun("0 9 * * *", at("2026-06-07T12:00:00Z"), "Europe/London")?.toISOString()).toBe("2026-06-08T08:00:00.000Z");
    expect(nextRun("0 9 * * *", at("2026-11-07T12:00:00Z"), "America/New_York")?.toISOString()).toBe("2026-11-07T14:00:00.000Z"); // 7am there
  });

  it("explains bad schedules", () => {
    expect(() => parseSchedule("* * * *")).toThrow(/five parts/);
    expect(() => parseSchedule("61 * * * *")).toThrow(/minute.*out of range/);
    expect(() => parseSchedule("* * * * mon")).toThrow(/day of week/);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
