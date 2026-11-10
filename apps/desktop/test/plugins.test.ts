import { describe, expect, it } from "vitest";
import {
  contentsSummary,
  filterPlugins,
  gitInstallArgs,
  gitUrlProblem,
  installNotice,
  pluginInitial,
  type PluginContents,
  type PluginSummary,
} from "../src/lib/plugins.ts";

const contents = (p: Partial<PluginContents> = {}): PluginContents => ({
  skills: [],
  commands: [],
  agents: [],
  mcpServers: [],
  hooks: [],
  hooksApplied: false,
  ...p,
});

const plugin = (name: string, p: Partial<PluginSummary> = {}): PluginSummary => ({
  name,
  description: "",
  version: "1.0.0",
  author: null,
  homepage: null,
  source: "https://example.com/x.git",
  sourceKind: "git",
  ref: null,
  enabled: true,
  installedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  commit: null,
  contents: contents(),
  problem: null,
  ...p,
});

describe("plugin helpers", () => {
  it("checks git links the way the app does", () => {
    expect(gitUrlProblem("https://github.com/acme/plugin")).toBeNull();
    expect(gitUrlProblem("")).toMatch(/Paste/);
    expect(gitUrlProblem("git@github.com:acme/plugin.git")).toMatch(/https/);
    expect(gitUrlProblem("http://github.com/acme/plugin")).toMatch(/https/);
    expect(gitUrlProblem("https://me:token@github.com/acme/plugin")).toMatch(/sign-in/);
    expect(gitUrlProblem("https://github.com/")).toMatch(/no repository path/);
  });

  it("searches names, descriptions and what plugins give, and shows updates", () => {
    const list = [plugin("review-kit", { description: "Code review" }), plugin("db", { contents: contents({ mcpServers: ["postgres"] }) })];
    expect(filterPlugins(list, "", "all", new Set()).map(p => p.name)).toEqual(["review-kit", "db"]);
    expect(filterPlugins(list, "REVIEW", "installed", new Set()).map(p => p.name)).toEqual(["review-kit"]);
    expect(filterPlugins(list, "postgres", "all", new Set()).map(p => p.name)).toEqual(["db"]);
    expect(filterPlugins(list, "", "updates", new Set(["db"])).map(p => p.name)).toEqual(["db"]);
  });

  it("describes what a plugin gives in words", () => {
    expect(contentsSummary(contents({ skills: ["a", "b"], commands: ["c"], mcpServers: ["m"] }))).toBe("2 skills, 1 command and 1 MCP server");
    expect(contentsSummary(contents({ agents: ["x"] }))).toBe("1 subagent");
    expect(contentsSummary(contents({ hooks: ["Stop"] }))).toMatch(/hooks/);
    expect(contentsSummary(contents())).toMatch(/Nothing/);
  });

  it("picks a tile letter", () => {
    expect(pluginInitial("review-kit")).toBe("R");
    expect(pluginInitial("_x")).toBe("X");
    expect(pluginInitial("--")).toBe("?");
  });
});

describe("installing a plugin", () => {
  it("asks for a fetched plugin to arrive turned off unless told otherwise", () => {
    expect(gitInstallArgs(" https://example.com/kit.git ", " main ", "")).toEqual({
      url: "https://example.com/kit.git",
      gitRef: "main",
      plugin: null,
      turnOn: false,
    });
    expect(gitInstallArgs("https://example.com/market", undefined, "kit", { turnOn: true })).toMatchObject({ plugin: "kit", turnOn: true });
  });

  it("says whether the plugin is in use yet", () => {
    expect(installNotice({ installed: [plugin("kit")], skipped: [] })).toBe("Installed kit. New threads get it.");
    expect(installNotice({ installed: [plugin("kit", { enabled: false })], skipped: [] })).toBe(
      "Installed kit. It's turned off: look over what it adds, then turn it on.",
    );
  });

  it("says a marketplace's plugins start turned off, and what was left out", () => {
    const several = installNotice({ installed: [plugin("a", { enabled: false }), plugin("b", { enabled: false })], skipped: ["c: no manifest."] });
    expect(several).toBe("Installed 2 plugins from this marketplace. They start turned off, so turn on the ones you want. Not installed: c: no manifest.");
    expect(installNotice({ installed: [], skipped: ["c: no manifest."] })).toBe("Nothing was installed. Not installed: c: no manifest.");
  });
});
