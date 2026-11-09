import { describe, expect, it } from "vitest";
import { threadCardLines } from "../src/lib/threadCard.ts";

const now = Date.parse("2026-11-08T12:00:00.000Z");
const t = {
  repo: "/code/site",
  branch: "agent/abc",
  agent: { kind: "claude-code" as const, model: "opus" },
  mode: "local" as const,
  status: "running" as const,
  updatedAt: "2026-11-08T11:55:00.000Z",
};
const table = (lines: { label: string; value: string }[]) => Object.fromEntries(lines.map(l => [l.label, l.value]));

describe("the hover card on a sidebar row", () => {
  it("says the project, branch, agent and model, where it runs and when it last did something", () => {
    expect(table(threadCardLines(t, { now }))).toEqual({
      Project: "site",
      Branch: "agent/abc",
      Agent: "Claude Code, opus",
      Runs: "On this computer",
      "Last activity": "Working, 5 min ago",
    });
  });

  it("names the place for cloud threads and other machines", () => {
    expect(table(threadCardLines({ ...t, mode: "cloud", agent: { kind: "codex" } }, { now }))).toMatchObject({ Runs: "In the cloud", Agent: "Codex" });
    expect(table(threadCardLines({ ...t, machine: "m1" }, { now, machineName: "Studio" })).Runs).toBe("On Studio");
    expect(table(threadCardLines({ ...t, machine: "gone" }, { now })).Runs).toBe("On a removed machine");
  });

  it("adds the pull request when one is known", () => {
    expect(table(threadCardLines(t, { now }))["Pull request"]).toBeUndefined();
    expect(table(threadCardLines(t, { now, pullRequest: { number: 12, state: "open" } }))["Pull request"]).toBe("#12, open");
    expect(table(threadCardLines(t, { now, pullRequest: { number: 12, state: "open", draft: true } }))["Pull request"]).toBe("#12, draft");
    expect(table(threadCardLines(t, { now, pullRequest: { number: 3, state: "merged" } }))["Pull request"]).toBe("#3, merged");
    expect(table(threadCardLines(t, { now, pullRequest: {} }))["Pull request"]).toBe("Opened");
  });

  it("says when a snoozed thread comes back", () => {
    const lines = table(threadCardLines(t, { now, snoozedUntil: "2026-11-08T12:30:00.000Z" }));
    expect(lines.Snoozed).toMatch(/^Until /);
    expect(table(threadCardLines(t, { now })).Snoozed).toBeUndefined();
  });
});
