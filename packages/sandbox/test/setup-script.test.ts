import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchCommand } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

/** Run a launch command the way providers do (`sh -c`), with HOME in a temp folder. */
function run(command: string, home: string): string {
  return execFileSync("sh", ["-c", command], { env: { PATH: process.env.PATH, HOME: home }, cwd: home }).toString();
}

describe("setup scripts", () => {
  it("leave the command alone when there is none", () => {
    expect(launchCommand({ command: "lemonlime-runner --thread t1", port: 7420, env: {} })).toBe("lemonlime-runner --thread t1");
    expect(launchCommand({ command: "lemonlime-runner", port: 7420, env: {}, setupScript: "  \n" })).toBe("lemonlime-runner");
  });

  it("run once before the runner, and tell it where the output is", () => {
    const home = mkdtempSync(join(tmpdir(), "lemonlime-setup-"));
    dirs.push(home);
    const cmd = launchCommand({
      command: `echo "runner sees $LEMONLIME_SETUP_LOG"`,
      port: 7420,
      env: {},
      setupScript: "echo installing 'tools'\necho run >> \"$HOME/count\"",
    });
    expect(run(cmd, home).trim()).toBe(`runner sees ${home}/.lemonlime/setup.log`);
    expect(run(cmd, home).trim()).toBe(`runner sees ${home}/.lemonlime/setup.log`); // a restart: not run again
    expect(readFileSync(join(home, "count"), "utf8")).toBe("run\n");
    expect(readFileSync(join(home, ".lemonlime", "setup.log"), "utf8")).toBe("exit 0\ninstalling tools\n");
  });

  it("don't see the thread secret or the keeper's address, which the runner still gets", () => {
    const home = mkdtempSync(join(tmpdir(), "lemonlime-setup-"));
    dirs.push(home);
    const cmd = launchCommand({
      command: `echo "runner has $LEMONLIME_THREAD_SECRET $LEMONLIME_KEEPER"`,
      port: 7420,
      env: {},
      setupScript: 'echo "script has [$LEMONLIME_THREAD_SECRET] [$LEMONLIME_KEEPER] [$OTHER]"',
    });
    const out = execFileSync("sh", ["-c", cmd], {
      env: { PATH: process.env.PATH, HOME: home, LEMONLIME_THREAD_SECRET: "the-secret", LEMONLIME_KEEPER: "/run/keeper.sock", OTHER: "kept" },
      cwd: home,
    }).toString();
    expect(out.trim()).toBe("runner has the-secret /run/keeper.sock");
    expect(readFileSync(join(home, ".lemonlime", "setup.log"), "utf8")).toBe("exit 0\nscript has [] [] [kept]\n");
  });

  it("record a failing script's exit code, and still start the runner", () => {
    const home = mkdtempSync(join(tmpdir(), "lemonlime-setup-"));
    dirs.push(home);
    const cmd = launchCommand({ command: "echo started", port: 7420, env: {}, setupScript: "echo oops >&2\nexit 3" });
    expect(run(cmd, home).trim()).toBe("started");
    expect(readFileSync(join(home, ".lemonlime", "setup.log"), "utf8")).toBe("exit 3\noops\n");
  });
});
