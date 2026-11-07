import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, TESTED_AGENTS, versionNotice } from "../src/index.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

describe("tested agent versions", () => {
  it("parses and compares CLI versions", () => {
    expect(parseVersion("2.1.302 (Claude Code)")).toBe("2.1.302");
    expect(parseVersion("codex-cli 0.167.0")).toBe("0.167.0");
    expect(parseVersion("no version here")).toBeNull();
    expect(compareVersions("0.145.0", "0.167.0")).toBeLessThan(0);
    expect(compareVersions("0.167.0", "0.167.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("notes a CLI older than the tested one, and stays quiet otherwise", () => {
    expect(versionNotice("codex", "0.145.0")).toMatch(/older than the version LemonLime is tested with \(0\.167\.0\).*`codex update`/);
    expect(versionNotice("codex", "0.167.0")).toBeNull();
    expect(versionNotice("codex", "0.200.0")).toBeNull();
    expect(versionNotice("codex", null)).toBeNull();
    expect(versionNotice("acp", "0.0.1")).toBeNull();
  });

  // Bumping a tested version means re-recording; these keep everything in step.
  it("matches the recorded fix-bug run of every agent", () => {
    for (const [kind, info] of Object.entries(TESTED_AGENTS)) {
      const fixture = readFileSync(join(here, "fixtures", "agents", kind, "fix-bug.jsonl"), "utf8").split("\n")[0]!;
      expect(JSON.parse(fixture), kind).toMatchObject({ dir: "meta", version: info.version });
    }
  });

  it("matches the versions the sandbox image installs", () => {
    const docker = readFileSync(join(repoRoot, "docker", "sandbox.Dockerfile"), "utf8");
    const arg = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(docker)?.[1];
    expect(arg("CLAUDE_CODE_VERSION")).toBe(TESTED_AGENTS["claude-code"].version);
    expect(arg("CODEX_VERSION")).toBe(TESTED_AGENTS.codex.version);
    expect(arg("OPENCODE_VERSION")).toBe(TESTED_AGENTS.opencode.version);
    for (const info of Object.values(TESTED_AGENTS)) expect(docker).toContain(`"${info.npm}@\${`);
  });

  it("matches the fixtures README", () => {
    const readme = readFileSync(join(here, "fixtures", "agents", "README.md"), "utf8");
    for (const info of Object.values(TESTED_AGENTS)) expect(readme).toContain(`| ${info.version}`);
    expect(readdirSync(join(here, "fixtures", "agents")).filter(d => !d.includes("."))).toEqual(expect.arrayContaining(Object.keys(TESTED_AGENTS)));
  });
});
