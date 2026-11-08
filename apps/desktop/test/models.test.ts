import { describe, expect, it } from "vitest";
import { AGENT_CAPABILITIES } from "@lemonlime/protocol";
import {
  agentsToAutoUpdate,
  cycleEffort,
  effortLevels,
  filterModels,
  harnessRows,
  modelLabel,
  moveAgent,
  orderedAgents,
  parseOpencodeModels,
  pickerAgents,
  splitModels,
} from "../src/lib/models.ts";
import { COMPOSER_SHORTCUTS, SHORTCUTS, comboOf, keysFor, matchShortcut } from "../src/lib/shortcuts.ts";
import type { AgentInstall } from "../src/lib/system.ts";

const install = (kind: AgentInstall["kind"], o: Partial<AgentInstall> = {}): AgentInstall => ({
  kind,
  installed: true,
  path: `/usr/local/bin/${kind}`,
  version: "9.9.9",
  signedIn: true,
  viaNpm: true,
  ...o,
});

describe("model search", () => {
  const claude = AGENT_CAPABILITIES["claude-code"].models;

  it("matches every word against the name or id, ignoring case and separators", () => {
    expect(filterModels(claude, "opus").map(m => m.label)).toEqual(["Opus 5.5", "Opus 5", "Opus 4.8", "Opus 4.7"]);
    expect(filterModels(claude, "OPUS 4.8").map(m => m.id)).toEqual(["claude-opus-4-8"]);
    expect(filterModels(claude, "sonnet55").map(m => m.id)).toEqual(["claude-sonnet-5-5"]);
    expect(filterModels(claude, "  ")).toHaveLength(claude.length);
    expect(filterModels(claude, "gpt")).toEqual([]);
  });

  it("keeps older models under More models, and names unknown ids as they are", () => {
    const { main, older } = splitModels(claude);
    expect(main.map(m => m.label)).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    expect(older.every(m => m.older)).toBe(true);
    expect(modelLabel(claude, "claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel(claude, "my-own-model")).toBe("my-own-model");
    expect(modelLabel(claude, null)).toBeNull();
  });
});

describe("OpenCode's model list", () => {
  it("reads the plain list", () => {
    const text = "opencode/beam-free\nopencode/big-pickle\nanthropic/claude-sonnet-5-5\n\nopenrouter/qwen/qwen3-coder\n";
    expect(parseOpencodeModels(text)).toEqual([
      { id: "opencode/beam-free", label: "OpenCode/beam-free" },
      { id: "opencode/big-pickle", label: "OpenCode/big-pickle" },
      { id: "anthropic/claude-sonnet-5-5", label: "Anthropic/claude-sonnet-5-5" },
      { id: "openrouter/qwen/qwen3-coder", label: "OpenRouter/qwen/qwen3-coder" },
    ]);
  });

  it("reads the verbose list, with names and long context windows", () => {
    const details = (name: string, context: number) =>
      JSON.stringify(
        { id: "x", providerID: "opencode", name, limit: { context, output: 131072 }, capabilities: { reasoning: true }, variants: { low: {} } },
        null,
        2,
      );
    const text = [
      "opencode/beam-free",
      details("Beam Free", 1048576),
      "opencode/big-pickle",
      details("Big Pickle", 200000),
      "opencode/broken",
      "{",
      '  "name": "Never closed",',
      "opencode/iceman-free",
      "",
    ].join("\n");
    expect(parseOpencodeModels(text)).toEqual([
      { id: "opencode/beam-free", label: "OpenCode/Beam Free", context: "1M" },
      { id: "opencode/big-pickle", label: "OpenCode/Big Pickle" },
      { id: "opencode/broken", label: "OpenCode/broken" },
    ]);
  });

  it("skips log lines, errors and repeats", () => {
    const text = 'INFO  2026-11-08 service=models refreshing\nError: something went wrong\n{"a":1}\nopencode/big-pickle\nopencode/big-pickle\r\n';
    expect(parseOpencodeModels(text).map(m => m.id)).toEqual(["opencode/big-pickle"]);
    expect(parseOpencodeModels("")).toEqual([]);
  });

  it("reads details printed on one line", () => {
    expect(parseOpencodeModels('opencode/beam-free\n{"name":"Beam Free","limit":{"context":2000000}}\n')).toEqual([
      { id: "opencode/beam-free", label: "OpenCode/Beam Free", context: "2M" },
    ]);
  });
});

describe("agent order", () => {
  it("keeps every agent once, the user's order first", () => {
    expect(orderedAgents(["codex"])).toEqual(["codex", "claude-code", "opencode", "acp"]);
    expect(orderedAgents([])).toEqual(["claude-code", "codex", "opencode", "acp"]);
  });

  it("moves an agent, staying in bounds", () => {
    expect(moveAgent([], "opencode", 0)).toEqual(["opencode", "claude-code", "codex", "acp"]);
    expect(moveAgent([], "claude-code", 99)).toEqual(["codex", "opencode", "acp", "claude-code"]);
    expect(moveAgent(["codex", "claude-code"], "claude-code", -1)).toEqual(["claude-code", "codex", "opencode", "acp"]);
  });

  it("offers the agents on this computer, in order, never hidden ones, always the one in use", () => {
    const base = { order: ["codex", "claude-code"] as const, hidden: [] as const, inShell: true, acpSaved: 0, current: "codex" as const };
    const installed = [install("claude-code"), install("codex"), install("opencode", { installed: false })];
    expect(pickerAgents({ ...base, order: [...base.order], hidden: [], installed })).toEqual(["codex", "claude-code"]);
    expect(pickerAgents({ ...base, order: [...base.order], hidden: ["claude-code"], installed })).toEqual(["codex"]);
    expect(pickerAgents({ ...base, order: [...base.order], hidden: ["codex"], installed })).toEqual(["codex", "claude-code"]);
    expect(pickerAgents({ ...base, order: [], hidden: [], installed, acpSaved: 2 })).toEqual(["claude-code", "codex", "acp"]);
    // Outside the desktop app nothing can be detected, so every agent is offered.
    expect(pickerAgents({ ...base, order: [], hidden: [], installed: [], inShell: false })).toEqual(["claude-code", "codex", "opencode"]);
  });
});

describe("effort", () => {
  it("cycles through the levels and round again", () => {
    const levels = effortLevels("claude-code", false);
    expect(levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cycleEffort(levels, "low")).toBe("medium");
    expect(cycleEffort(levels, "xhigh")).toBe("low");
    expect(cycleEffort(levels, null)).toBe("low");
    expect(cycleEffort(levels, "max")).toBe("low");
    expect(cycleEffort([], "low")).toBeNull();
    expect(effortLevels("claude-code", true)).toContain("max");
    expect(effortLevels("opencode", true)).toEqual([]);
  });

  it("⌥T cycles it, on any keyboard, and clashes with no other shortcut", () => {
    expect(keysFor("cycle-effort", {})).toBe("alt+t");
    // macOS types "†" for ⌥T; the key's place still says T.
    const e = { key: "†", code: "KeyT", altKey: true, metaKey: false, ctrlKey: false, shiftKey: false };
    expect(comboOf(e)).toBe("alt+t");
    expect(matchShortcut(e as KeyboardEvent, {})).toBe("cycle-effort");
    const defaults = SHORTCUTS.map(s => s.keys);
    expect(new Set(defaults).size).toBe(defaults.length);
    expect(COMPOSER_SHORTCUTS).toContain("cycle-effort");
  });
});

describe("the Harness table", () => {
  it("lists installed agents in order with the default marked, and the rest under Not installed", () => {
    const { installed, notInstalled } = harnessRows({
      agents: [
        install("claude-code", { version: "1.0.0" }),
        install("codex", { signedIn: false, viaNpm: false }),
        install("opencode", { installed: false, version: null }),
      ],
      order: ["codex"],
      hidden: ["claude-code"],
      defaultAgent: "claude-code",
      autoUpdate: ["claude-code"],
    });
    expect(installed.map(r => [r.kind, r.isDefault, r.status, r.autoUpdate, r.hidden])).toEqual([
      ["codex", false, "sign-in", "unavailable", false],
      ["claude-code", true, "update", "on", true],
    ]);
    expect(notInstalled.map(r => r.kind)).toEqual(["opencode"]);
    expect(notInstalled[0]!.autoUpdate).toBe("unavailable");
  });

  it("updates on launch only what's switched on, installed with npm and out of date", () => {
    const agents = [
      install("claude-code", { version: "1.0.0" }),
      install("codex", { version: "1.0.0", viaNpm: false }),
      install("opencode", { version: "99.0.0" }),
    ];
    expect(agentsToAutoUpdate(agents, ["claude-code", "codex", "opencode"])).toEqual(["claude-code"]);
    expect(agentsToAutoUpdate(agents, [])).toEqual([]);
  });
});
