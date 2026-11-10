import { describe, expect, it } from "vitest";
import { CloudApi, CloudError, type AutomationInfo } from "../src/lib/cloud.ts";
import {
  automationBody,
  automationForm,
  canManageAutomation,
  newAutomationForm,
  pausedLine,
  pickSecret,
  secretChoiceIgnored,
  secretChoices,
} from "../src/lib/automations.ts";

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

describe("the secrets an automation's runs get", () => {
  const picky: AutomationInfo = { ...nightly, secretNames: ["NPM_TOKEN", "SENTRY_KEY"] };

  it("says nothing about secrets for a new automation left on all of them", () => {
    const body = automationBody({ ...newAutomationForm("0 9 * * 1", "UTC"), name: "Bump", repoUrl: "https://example.com/r.git", prompt: "Bump" });
    expect("secretNames" in body).toBe(false);
  });

  it("sends the list when one was chosen, an empty one included", () => {
    const form = newAutomationForm("0 9 * * 1", "UTC");
    expect(automationBody({ ...form, secretNames: ["NPM_TOKEN"] }).secretNames).toEqual(["NPM_TOKEN"]);
    expect(automationBody({ ...form, secretNames: [] }).secretNames).toEqual([]);
  });

  it("opens an automation with the list it has, and with all secrets when it has none", () => {
    expect(automationForm(picky, "UTC").secretNames).toEqual(["NPM_TOKEN", "SENTRY_KEY"]);
    expect(automationForm({ ...nightly, secretNames: null }, "UTC").secretNames).toBeNull();
    expect(automationForm(nightly, "UTC").secretNames).toBeNull();
  });

  it("leaves the field out when an automation on all secrets is changed in some other way", () => {
    expect("secretNames" in automationBody({ ...automationForm(nightly, "UTC"), name: "Renamed" }, nightly)).toBe(false);
    const all = { ...nightly, secretNames: null };
    expect("secretNames" in automationBody(automationForm(all, "UTC"), all)).toBe(false);
  });

  it("says so when an automation that had a list goes back to all secrets", () => {
    const body = automationBody({ ...automationForm(picky, "UTC"), secretNames: null }, picky);
    expect(body.secretNames).toBeNull();
    const none = { ...nightly, secretNames: [] };
    expect(automationBody({ ...automationForm(none, "UTC"), secretNames: null }, none).secretNames).toBeNull();
  });

  it("ticks and unticks one secret at a time", () => {
    expect(pickSecret([], "NPM_TOKEN", true)).toEqual(["NPM_TOKEN"]);
    expect(pickSecret(["NPM_TOKEN"], "NPM_TOKEN", true)).toEqual(["NPM_TOKEN"]);
    expect(pickSecret(["NPM_TOKEN", "SENTRY_KEY"], "NPM_TOKEN", false)).toEqual(["SENTRY_KEY"]);
  });

  it("still offers a chosen secret the workspace no longer has, so it can be unticked", () => {
    expect(secretChoices(["NPM_TOKEN"], ["NPM_TOKEN", "OLD_KEY"])).toEqual([
      { name: "NPM_TOKEN", gone: false },
      { name: "OLD_KEY", gone: true },
    ]);
    expect(secretChoices(["NPM_TOKEN"], null)).toEqual([{ name: "NPM_TOKEN", gone: false }]);
  });

  it("notices a control plane that took no notice of the list", () => {
    const sent = { secretNames: ["NPM_TOKEN"] };
    expect(secretChoiceIgnored(sent, nightly)).toBe(true);
    expect(secretChoiceIgnored(sent, { secretNames: ["NPM_TOKEN"] })).toBe(false);
    expect(secretChoiceIgnored({}, nightly)).toBe(false);
    expect(secretChoiceIgnored({ secretNames: null }, nightly)).toBe(false);
  });

  it("reaches the control plane only when a list was chosen", async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = new CloudApi({ url: "http://cp.test", token: "t" }, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ automation: nightly }), { status: 200 });
    });
    const form = { ...newAutomationForm("0 9 * * 1", "UTC"), name: "Bump", repoUrl: "https://example.com/r.git", prompt: "Bump" };
    await api.createAutomation(automationBody(form));
    await api.createAutomation(automationBody({ ...form, secretNames: ["NPM_TOKEN"] }));
    await api.updateAutomation("auto-1", automationBody({ ...automationForm(picky, "UTC"), secretNames: null }, picky));
    expect("secretNames" in bodies[0]!).toBe(false);
    expect(bodies[1]!.secretNames).toEqual(["NPM_TOKEN"]);
    expect(bodies[2]!.secretNames).toBeNull();
  });
});

describe("who can change an automation", () => {
  it("is everyone the control plane doesn't rule out", () => {
    expect(canManageAutomation({ canManage: true })).toBe(true);
    expect(canManageAutomation({})).toBe(true);
  });

  it("isn't a member looking at someone else's automation", () => {
    expect(canManageAutomation({ canManage: false })).toBe(false);
  });

  it("only tells the person who can turn it back on that they paused it", () => {
    expect(pausedLine({ canManage: true })).toBe("Paused by you.");
    expect(pausedLine({})).toBe("Paused by you.");
    expect(pausedLine({ canManage: false })).toBe("Paused.");
    expect(pausedLine({ canManage: false, pausedReason: "It failed three times in a row." })).toBe("Paused automatically. It failed three times in a row.");
  });
});

describe("a schedule the control plane refuses", () => {
  it("comes back with the control plane's own words, for the form to show", async () => {
    const api = new CloudApi(
      { url: "http://cp.test", token: "t" },
      async () => new Response(JSON.stringify({ error: "bad_request", message: "A schedule can run at most once every so often." }), { status: 400 }),
    );
    const form = { ...newAutomationForm("* * * * *", "UTC"), name: "Busy", repoUrl: "https://example.com/r.git", prompt: "Look" };
    const err = await api.createAutomation(automationBody(form)).catch(e => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.message).toBe("A schedule can run at most once every so often.");
    const changed = await api.updateAutomation("auto-1", { schedule: "* * * * *" }).catch(e => e);
    expect(changed.message).toBe("A schedule can run at most once every so often.");
  });
});
