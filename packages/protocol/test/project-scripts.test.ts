import { describe, expect, it } from "vitest";
import { parseProjectConfig, parseTerminalClientMessage, scriptEnv, scriptIdFor, scriptTerminalId, TerminalId } from "../src/index.ts";

describe("project scripts", () => {
  it("reads scripts, giving each a unique id", () => {
    const r = parseProjectConfig(
      JSON.stringify({
        scripts: [
          { name: "Dev server", command: "pnpm dev", icon: "play", previewUrl: "http://localhost:5173/app", keybinding: "run-script-1" },
          { name: "Test", command: "pnpm test" },
          { name: "test", command: "pnpm test:e2e" },
          { id: "setup", name: "Setup", command: "pnpm install", runOnWorktreeCreate: true, timeoutSeconds: 120 },
        ],
      }),
    );
    expect("scripts" in r && r.scripts.map(s => s.id)).toEqual(["dev-server", "test", "test-2", "setup"]);
    expect("scripts" in r && r.scripts[3]).toMatchObject({ runOnWorktreeCreate: true, timeoutSeconds: 120 });
  });

  it("explains what's wrong with a bad file", () => {
    expect(parseProjectConfig("{ nope")).toEqual({ error: "lemonlime.json isn't valid JSON." });
    const noCommand = parseProjectConfig(JSON.stringify({ scripts: [{ name: "Dev" }] }));
    expect("error" in noCommand && noCommand.error).toMatch(/scripts\.0\.command/);
    const remote = parseProjectConfig(JSON.stringify({ scripts: [{ name: "Dev", command: "x", previewUrl: "https://example.com" }] }));
    expect("error" in remote && remote.error).toMatch(/local address/);
    const badKey = parseProjectConfig(JSON.stringify({ scripts: [{ name: "Dev", command: "x", keybinding: "mod+k" }] }));
    expect("error" in badKey).toBe(true);
    expect(parseProjectConfig("{}")).toEqual({ scripts: [] });
  });

  it("makes ids that fit in a terminal id", () => {
    expect(scriptIdFor("Run tests!")).toBe("run-tests");
    expect(scriptIdFor("ÉLAN dev")).toBe("elan-dev");
    expect(scriptIdFor("!!!")).toBe("script");
    const long = scriptIdFor("a very long script name that keeps going on and on");
    expect(TerminalId.safeParse(scriptTerminalId(long)).success).toBe(true);
  });

  it("gives scripts the project and worktree paths, and terminals can ask for a script", () => {
    expect(scriptEnv({ projectRoot: "/r", worktree: "/w", threadId: "t1" })).toEqual({
      LEMONLIME_PROJECT_ROOT: "/r",
      LEMONLIME_WORKTREE_PATH: "/w",
      LEMONLIME_THREAD_ID: "t1",
    });
    const hello = parseTerminalClientMessage(JSON.stringify({ type: "hello", token: "t", cols: 80, rows: 24, terminal: "script-dev", script: "dev" }));
    expect(hello).toMatchObject({ script: "dev" });
    expect(parseTerminalClientMessage(JSON.stringify({ type: "hello", token: "t", cols: 80, rows: 24, script: "../x" }))).toBeNull();
  });
});
