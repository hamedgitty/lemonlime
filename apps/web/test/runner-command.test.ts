import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildRunnerCommand, buildRunnerLaunch, runnerArgs, shellQuote, validateCloudLaunch } from "../src/lib/runner-command.ts";

/** Ask a real POSIX shell how it splits a command line. */
function shellSplit(command: string): string[] {
  const out = execFileSync("sh", ["-c", `set -- ${command}; for a in "$@"; do printf '%s\\0' "$a"; done`]);
  return out.toString("utf8").split("\0").slice(0, -1);
}

const base = {
  threadId: "abc123-thread",
  agent: { kind: "claude-code" as const },
  repo: { url: "https://github.com/acme/app.git", baseBranch: "main" },
  controlPlaneUrl: "https://control.example.com",
};

describe("shellQuote", () => {
  it("leaves plain words alone", () => {
    expect(shellQuote("lemonlime-runner")).toBe("lemonlime-runner");
    expect(shellQuote("https://github.com/acme/app.git")).toBe("https://github.com/acme/app.git");
  });

  it("quotes empty strings, spaces and shell syntax", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("rejects NUL bytes", () => {
    expect(() => shellQuote("a\0b")).toThrow();
  });

  it.each(["a b", "it's", "$(whoami)", "`id`", "x;y|z&w", "line1\nline2", '"double"', "back\\slash", "*?[]{}", "~user", "#hash", "'"])(
    "round-trips %j through sh",
    value => {
      expect(shellSplit(shellQuote(value))).toEqual([value]);
    },
  );
});

describe("runner command", () => {
  it("follows the documented argument order", () => {
    expect(buildRunnerCommand(base)).toBe(
      "lemonlime-runner --thread abc123-thread --agent claude-code --repo https://github.com/acme/app.git --base main --host 0.0.0.0 --port 7420 --control-plane https://control.example.com",
    );
  });

  it("passes the reasoning level", () => {
    const args = runnerArgs({ ...base, agent: { kind: "codex", model: "gpt-6-astra", reasoning: "high" } });
    expect(args.slice(args.indexOf("--reasoning"), args.indexOf("--reasoning") + 2)).toEqual(["--reasoning", "high"]);
  });

  it("adds model and ACP command, each as one safely quoted argument", () => {
    const args = runnerArgs({
      ...base,
      agent: { kind: "acp", command: ["gemini", "--experimental-acp", "it's"], model: "pro model" },
    });
    expect(args.slice(0, 9)).toEqual([
      "lemonlime-runner",
      "--thread",
      "abc123-thread",
      "--agent",
      "acp",
      "--agent-command",
      "gemini --experimental-acp 'it'\\''s'",
      "--model",
      "pro model",
    ]);
    const command = buildRunnerCommand({ ...base, agent: { kind: "acp", command: ["gemini", "--experimental-acp", "it's"], model: "pro model" } });
    expect(shellSplit(command)).toEqual(args);
  });

  it("keeps hostile values inert", () => {
    const hostile = { ...base, repo: { url: "https://x.example/$(touch /tmp/pwned);`id`.git", baseBranch: "main" } };
    expect(shellSplit(buildRunnerCommand(hostile))).toEqual(runnerArgs(hostile));
  });

  it("refuses values that look like flags", () => {
    expect(() => runnerArgs({ ...base, agent: { kind: "codex", model: "--evil" } })).toThrow();
    expect(() => runnerArgs({ ...base, repo: { url: "-u", baseBranch: "main" } })).toThrow();
  });

  it("requires a command for ACP agents", () => {
    expect(() => runnerArgs({ ...base, agent: { kind: "acp" } })).toThrow();
  });

  it("passes only the thread secret in the environment", () => {
    const launch = buildRunnerLaunch({ ...base, threadSecret: "s3cret" });
    expect(launch.port).toBe(7420);
    expect(launch.env).toEqual({ LEMONLIME_THREAD_SECRET: "s3cret" });
    expect(launch.command).not.toContain("s3cret");
  });
});

describe("validateCloudLaunch", () => {
  const agent = { kind: "claude-code" as const };
  it("accepts common git URLs and branch names", () => {
    expect(validateCloudLaunch(agent, { url: "https://github.com/a/b.git", baseBranch: "main" })).toBeNull();
    expect(validateCloudLaunch(agent, { url: "git@github.com:a/b.git", baseBranch: "release/1.2" })).toBeNull();
  });
  it("rejects local paths and odd branches", () => {
    expect(validateCloudLaunch(agent, { url: "/home/me/project", baseBranch: "main" })).not.toBeNull();
    expect(validateCloudLaunch(agent, { url: "https://github.com/a/b.git", baseBranch: "-x" })).not.toBeNull();
    expect(validateCloudLaunch(agent, { url: "https://github.com/a/b.git", baseBranch: "a..b" })).not.toBeNull();
    expect(validateCloudLaunch(agent, { url: "https://github.com/a/b.git", baseBranch: "a b" })).not.toBeNull();
  });
  it("needs a command for ACP agents", () => {
    expect(validateCloudLaunch({ kind: "acp" }, { url: "https://github.com/a/b.git", baseBranch: "main" })).not.toBeNull();
  });
});
