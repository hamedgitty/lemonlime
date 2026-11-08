import { describe, expect, it } from "vitest";
import {
  branchForThread,
  isSafeBranchPrefix,
  PutWorkspaceSettingsRequest,
  PutWorkspaceSkillsRequest,
  USER_SKILLS_MAX_BYTES,
} from "../src/index.ts";

describe("branch prefixes", () => {
  it("default to agent/ and accept other safe prefixes", () => {
    expect(branchForThread("abc123")).toBe("agent/abc123");
    expect(branchForThread("abc123", "ai/")).toBe("ai/abc123");
    expect(branchForThread("abc123", "team/bots/lemonlime-")).toBe("team/bots/lemonlime-abc123");
    for (const ok of ["agent/", "ai", "lemonlime-", "a_b.c/", "hamed/agent/"]) expect(isSafeBranchPrefix(ok)).toBe(true);
  });

  it("refuse prefixes git would reject or that look like options", () => {
    const bad = ["", "-x/", "/agent/", "a//b/", "a..b/", ".hidden/", "x.lock/", "x./", "a b/", "a~1/", "a^/", "a:b/", "a?/", "a*/", "a[/", "a\\b/", "a@{/", "x".repeat(101)];
    for (const p of bad) expect(isSafeBranchPrefix(p), p).toBe(false);
    expect(() => branchForThread("abc123", "../")).toThrow();
  });
});

describe("workspace settings", () => {
  it("cap instructions and the setup script", () => {
    expect(PutWorkspaceSettingsRequest.safeParse({ instructions: "x".repeat(32 * 1024) }).success).toBe(true);
    expect(PutWorkspaceSettingsRequest.safeParse({ instructions: "x".repeat(32 * 1024 + 1) }).success).toBe(false);
    expect(PutWorkspaceSettingsRequest.safeParse({ setupScript: "é".repeat(8 * 1024 + 1) }).success).toBe(false); // bytes, not characters
    expect(PutWorkspaceSettingsRequest.safeParse({ retryMaxWaitMinutes: -1 }).success).toBe(false);
    expect(PutWorkspaceSettingsRequest.safeParse({ autoDeleteDays: 0 }).success).toBe(false);
    expect(PutWorkspaceSettingsRequest.safeParse({ autoDeleteDays: null, stripCoauthors: true }).success).toBe(true);
  });

  it("check skills: a SKILL.md each, safe paths, unique names, a total size", () => {
    const skill = (name: string, files: Record<string, string> = { "SKILL.md": "# hi" }) => ({ name, files });
    expect(PutWorkspaceSkillsRequest.safeParse({ skills: [skill("review"), skill("deploy", { "SKILL.md": "x", "scripts/run.sh": "echo" })] }).success).toBe(true);
    expect(PutWorkspaceSkillsRequest.safeParse({ skills: [skill("review", { "README.md": "x" })] }).success).toBe(false);
    expect(PutWorkspaceSkillsRequest.safeParse({ skills: [skill("review"), skill("review")] }).success).toBe(false);
    expect(PutWorkspaceSkillsRequest.safeParse({ skills: [skill("../up")] }).success).toBe(false);
    for (const path of ["../x", "/etc/passwd", "a//b", "a/./b", "a\\b"]) {
      expect(PutWorkspaceSkillsRequest.safeParse({ skills: [skill("s", { "SKILL.md": "x", [path]: "x" })] }).success, path).toBe(false);
    }
    const big = "x".repeat(USER_SKILLS_MAX_BYTES / 2);
    expect(PutWorkspaceSkillsRequest.safeParse({ skills: [skill("a", { "SKILL.md": big }), skill("b", { "SKILL.md": big })] }).success).toBe(false);
  });
});
