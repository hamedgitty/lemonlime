import { describe, expect, it } from "vitest";
import { isValidTimeZone, nextRun, parseSchedule, shortestGapMinutes } from "../src/index.ts";

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

  // New York, 2026: clocks go forward on 8 March (02:00 becomes 03:00, at 07:00Z) and back on
  // 1 November (02:00 becomes 01:00, at 06:00Z).
  const next = (cron: string, after: string, tz: string) => nextRun(cron, at(after), tz)?.toISOString();

  it("runs a time the clocks skip once, at the first minute after the gap", () => {
    // 02:30 doesn't happen on 8 March: run at 03:00 instead of missing the day.
    expect(next("30 2 * * *", "2026-03-07T12:00:00Z", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
    expect(next("30 2 * * *", "2026-03-08T07:00:00Z", "America/New_York")).toBe("2026-03-09T06:30:00.000Z");
    // Two skipped times and the one right after the gap are a single run.
    expect(next("0,30 2,3 * * *", "2026-03-08T06:00:00Z", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
    expect(next("0,30 2,3 * * *", "2026-03-08T07:00:00Z", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    // London, 29 March: 01:00 becomes 02:00 at 01:00Z.
    expect(next("30 1 * * *", "2026-03-28T12:00:00Z", "Europe/London")).toBe("2026-03-29T01:00:00.000Z");
  });

  it("runs a time the clocks repeat only once", () => {
    // 01:30 happens twice on 1 November (05:30Z and 06:30Z): run the first time only.
    expect(next("30 1 * * *", "2026-10-31T12:00:00Z", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-02T06:30:00.000Z");
    // London, 25 October: 02:00 becomes 01:00 at 01:00Z.
    expect(next("30 1 * * *", "2026-10-24T12:00:00Z", "Europe/London")).toBe("2026-10-25T00:30:00.000Z");
    expect(next("30 1 * * *", "2026-10-25T00:30:00Z", "Europe/London")).toBe("2026-10-26T01:30:00.000Z");
  });

  it("keeps an every-hour schedule at its pace through a clock change", () => {
    expect(next("*/15 * * * *", "2026-11-01T05:45:00Z", "America/New_York")).toBe("2026-11-01T06:00:00.000Z");
    expect(next("*/15 * * * *", "2026-11-01T06:00:00Z", "America/New_York")).toBe("2026-11-01T06:15:00.000Z");
    expect(next("30 * * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-01T06:30:00.000Z");
    expect(next("30 * * * *", "2026-03-08T06:30:00Z", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
  });

  it("finds the right time on and around a short or long day", () => {
    // Midnight to midnight is 23 hours on 8 March and 25 on 1 November.
    expect(next("0 0 * * *", "2026-03-08T05:00:00Z", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(next("0 0 * * *", "2026-11-01T04:00:00Z", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
    expect(next("0 9 * * *", "2026-03-08T07:00:00Z", "America/New_York")).toBe("2026-03-08T13:00:00.000Z");
    expect(next("0 9 * * *", "2026-11-01T06:30:00Z", "America/New_York")).toBe("2026-11-01T14:00:00.000Z");
    expect(next("0 3 * * 0", "2026-03-07T12:00:00Z", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
    expect(next("0 3 * * 0", "2026-03-08T07:00:00Z", "America/New_York")).toBe("2026-03-15T07:00:00.000Z");
  });

  it("measures the shortest time between two runs", () => {
    expect(shortestGapMinutes("* * * * *")).toBe(1);
    expect(shortestGapMinutes("*/15 * * * *")).toBe(15);
    expect(shortestGapMinutes("*/7 * * * *")).toBe(4); // :56, then :00
    expect(shortestGapMinutes("0 23,0 * * *")).toBe(60); // across midnight
    expect(shortestGapMinutes("0 9 * * 1-5")).toBe(24 * 60);
  });

  it("explains bad schedules", () => {
    expect(() => parseSchedule("* * * *")).toThrow(/five parts/);
    expect(() => parseSchedule("61 * * * *")).toThrow(/minute.*out of range/);
    expect(() => parseSchedule("* * * * mon")).toThrow(/day of week/);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});
