import { describe, expect, it } from "vitest";
import type { AutomationInfo } from "../src/lib/cloud.ts";
import { automationBody, automationForm, newAutomationForm } from "../src/lib/automations.ts";

const nightly: AutomationInfo = {
  id: "auto-1",
  name: "Nightly tidy",
  schedule: "0 2 * * *",
  timezone: "Asia/Tokyo",
  agent: { kind: "codex", model: "big-model", reasoning: "high" },
  repo: { url: "https://example.com/r.git", baseBranch: "develop" },
  sandboxSize: "large",
  prompt: "Tidy up",
  checkScript: "git status --short",
  enabled: true,
  nextRunAt: null,
};

describe("the automation form", () => {
  it("starts a new automation in this computer's time zone", () => {
    const form = newAutomationForm("0 9 * * 1", "Europe/Paris");
    expect(form).toMatchObject({ schedule: "0 9 * * 1", timezone: "Europe/Paris", baseBranch: "main", size: "small" });
  });

  it("keeps an automation's own time zone, model and effort when it is changed", () => {
    const form = automationForm(nightly, "Europe/Paris");
    expect(form.timezone).toBe("Asia/Tokyo");
    expect(automationBody({ ...form, name: "  Nightly sweep " })).toEqual({
      name: "Nightly sweep",
      schedule: "0 2 * * *",
      timezone: "Asia/Tokyo",
      agent: { kind: "codex", model: "big-model", reasoning: "high" },
      repo: { url: "https://example.com/r.git", baseBranch: "develop" },
      sandboxSize: "large",
      prompt: "Tidy up",
      checkScript: "git status --short",
    });
  });

  it("moves to another time zone only when one is picked", () => {
    const form = automationForm(nightly, "Europe/Paris");
    expect(automationBody({ ...form, timezone: "Europe/Paris" }).timezone).toBe("Europe/Paris");
  });

  it("uses this computer's time zone for an automation that has none", () => {
    expect(automationForm({ ...nightly, timezone: "" }, "Europe/Paris").timezone).toBe("Europe/Paris");
  });

  it("leaves the model out when the automation has none, and fills a missing branch with main", () => {
    const form = automationForm({ ...nightly, agent: { kind: "claude-code" } }, "Europe/Paris");
    const body = automationBody({ ...form, baseBranch: " " });
    expect(body.agent).toEqual({ kind: "claude-code" });
    expect(body.repo.baseBranch).toBe("main");
  });
});
