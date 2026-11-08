import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexGuardFlags } from "../src/agents/codex.ts";

const guard = [process.execPath, resolve(__dirname, "../bin/lemonlime-runner.js"), "command-guard"];

/** The hook's command line, as Codex would run it: through a shell, the request on stdin. */
function runHook(flags: string[], toolInput: Record<string, unknown>): { code: number; stderr: string } {
  const config = flags[1]!;
  const command = /command="((?:[^"\\]|\\.)*)"/.exec(config)![1]!.replace(/\\(["\\])/g, "$1");
  try {
    execFileSync("sh", ["-c", command], { input: JSON.stringify({ tool_name: "Bash", tool_input: toolInput }), stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stderr: Buffer };
    return { code: e.status, stderr: e.stderr.toString() };
  }
}

describe("the command guard for Codex in sandboxes", () => {
  it("is passed only when on, with hook trust skipped for that run", () => {
    expect(codexGuardFlags(false, guard)).toEqual([]);
    const flags = codexGuardFlags(true, guard);
    expect(flags[0]).toBe("-c");
    expect(flags[1]).toMatch(/^hooks\.PreToolUse=\[\{matcher="\^Bash\$",hooks=\[\{type="command",command=".*",timeout=10\}\]\}\]$/);
    expect(flags[2]).toBe("--dangerously-bypass-hook-trust");
  });

  it("blocks a destructive command Codex asks to run, and lets ordinary ones through", () => {
    const flags = codexGuardFlags(true, guard);
    const blocked = runHook(flags, { command: "gh repo delete someone/demo --yes" });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toMatch(/LemonLime blocked this command/);
    expect(runHook(flags, { command: "rm -rf ~" }).code).toBe(2);
    expect(runHook(flags, { command: "ls -la && git status" }).code).toBe(0);
  });
});
