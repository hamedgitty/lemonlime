import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexUsageWindows, readAccountUsage, saveAccountUsage } from "../src/accounts.ts";
import { claudeUsageWindows, parseClaudeLine } from "../src/agents/claude-code.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

describe("plan usage, as the agents report it", () => {
  it("reads Claude Code's rate-limit event into bars", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      session_id: "s1",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1794276000,
        unifiedWindows: {
          five_hour: { utilization: 0.071, resetsAt: 1794186406 },
          seven_day: { utilization: 0.25, resetsAt: 1794276000 },
          junk: { utilization: "x" },
        },
      },
    });
    const parsed = parseClaudeLine(line);
    expect(parsed.usage).toEqual([
      { kind: "five_hour", label: "5h", usedPercent: 7.1, resetsAt: new Date(1794186406 * 1000).toISOString() },
      { kind: "seven_day", label: "7d", usedPercent: 25, resetsAt: new Date(1794276000 * 1000).toISOString() },
    ]);
    expect(parsed.limitResetAt).toBeUndefined();
  });

  it("keeps a limit that was hit, and clamps odd numbers", () => {
    const parsed = parseClaudeLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1794276000, unifiedWindows: { five_hour: { utilization: 1.4 } } },
      }),
    );
    expect(parsed.limitResetAt).toBe(new Date(1794276000 * 1000).toISOString());
    expect(parsed.usage).toEqual([{ kind: "five_hour", label: "5h", usedPercent: 100 }]);
    expect(claudeUsageWindows(null)).toEqual([]);
  });

  it("reads Codex's account/rateLimits/read answer", () => {
    expect(
      codexUsageWindows({
        rateLimits: {
          primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1794186406 },
          secondary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 1794641114 },
        },
      }),
    ).toEqual([
      { kind: "five_hour", label: "5h", usedPercent: 7, resetsAt: new Date(1794186406 * 1000).toISOString() },
      { kind: "seven_day", label: "7d", usedPercent: 13, resetsAt: new Date(1794641114 * 1000).toISOString() },
    ]);
    expect(codexUsageWindows({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 1440 } } })).toEqual([
      { kind: "other", label: "1d", usedPercent: 50 },
    ]);
    expect(codexUsageWindows({})).toEqual([]);
  });

  it("keeps the latest report per account, and refuses odd account ids", () => {
    const home = mkdtempSync(join(tmpdir(), "ll-usage-"));
    dirs.push(home);
    expect(readAccountUsage(home, "claude-code", "default")).toBeNull();
    const at = new Date("2026-11-08T12:00:00Z");
    saveAccountUsage(home, "claude-code", "default", [{ kind: "seven_day", label: "7d", usedPercent: 25 }], at);
    expect(readAccountUsage(home, "claude-code", "default")).toEqual({
      windows: [{ kind: "seven_day", label: "7d", usedPercent: 25 }],
      observedAt: at.toISOString(),
    });
    expect(readAccountUsage(home, "codex", "default")).toBeNull();
    expect(() => saveAccountUsage(home, "codex", "../x", [{ kind: "other", label: "x", usedPercent: 1 }])).toThrow();
  });
});
