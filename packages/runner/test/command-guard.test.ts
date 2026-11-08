import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { commandGuardSettings, dangerousCommand, runCommandGuardHook } from "../src/index.ts";
import { selfCommand } from "../src/self.ts";

describe("command guard", () => {
  it("blocks commands that wreck the computer", () => {
    for (const cmd of [
      "rm -rf /",
      "sudo rm -rf / --no-preserve-root",
      "rm -rf /*",
      "rm -rf ~",
      "rm -fr $HOME",
      "cd /tmp && rm -Rf ~/",
      "rm -rf /Users/hamed",
      "rm -rf /usr",
      "mkfs.ext4 /dev/sda1",
      "diskutil eraseDisk APFS X disk2",
      "dd if=/dev/zero of=/dev/disk2 bs=1m",
      "cat junk > /dev/sda",
      ":(){ :|:& };:",
      "chmod -R 777 /",
      "FOO=1 rm -rf ~",
      "gh repo delete acme/site --yes",
      "cd x && gh repo delete --yes",
    ]) {
      expect(dangerousCommand(cmd), cmd).not.toBeNull();
    }
  });

  it("leaves ordinary work alone", () => {
    for (const cmd of [
      "rm -rf node_modules dist",
      "rm -rf ./build",
      "rm -rf ~/.cache/my-tool",
      "rm -rf /tmp/lemonlime-test",
      "rm ~/notes.txt",
      "dd if=/dev/zero of=./disk.img bs=1m count=10",
      "echo hi > /dev/null",
      "git clean -fdx",
      "chmod -R u+w ./src",
      "pnpm test",
      "gh repo view acme/site",
      "gh pr create --fill",
    ]) {
      expect(dangerousCommand(cmd), cmd).toBeNull();
    }
  });

  it("answers Claude Code's hook: exit 2 with a reason blocks", () => {
    expect(runCommandGuardHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf ~" } }))).toMatchObject({ code: 2 });
    expect(runCommandGuardHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))).toEqual({ code: 0, stderr: "" });
    expect(runCommandGuardHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/" } })).code).toBe(0);
    expect(runCommandGuardHook("not json").code).toBe(0);
  });

  it("the hook command Claude Code runs really works, paths with spaces and all", () => {
    const settings = commandGuardSettings();
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(command).toContain("'command-guard'");
    const run = (c: string) => spawnSync("sh", ["-c", command], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: c } }), encoding: "utf8" });
    const blocked = run("rm -rf /");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("LemonLime blocked this command");
    expect(run("echo ok").status).toBe(0);
    expect(selfCommand("command-guard").at(-1)).toBe("command-guard");
  });
});
