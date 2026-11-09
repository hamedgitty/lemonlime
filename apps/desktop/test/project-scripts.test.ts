import { describe, expect, it } from "vitest";
import { fetchProjectScripts, focusedScripts, scriptForShortcut, setFocusedScripts, type Script } from "../src/lib/runScripts.ts";

const connection = { url: "ws://127.0.0.1:7420/ws", token: async () => "tok" };
const dev: Script = { id: "dev", name: "Dev", command: "pnpm dev", keybinding: "run-script-1" };
const test: Script = { id: "test", name: "Test", command: "pnpm test", keybinding: "run-script-1" };

describe("project scripts in the app", () => {
  it("fetches the runner's scripts, and copes with an old runner", async () => {
    let seen = "";
    const ok = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ scripts: [dev] }), { status: 200 });
    }) as typeof fetch;
    expect(await fetchProjectScripts(connection, ok)).toEqual({ scripts: [dev] });
    expect(seen).toBe("http://127.0.0.1:7420/project-scripts");
    const old = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    expect(await fetchProjectScripts(connection, old)).toBeNull();
  });

  it("finds the script for a shortcut, and keeps the focused thread's list", () => {
    expect(scriptForShortcut([dev, test], "run-script-1")).toBe(dev);
    expect(scriptForShortcut([dev], "run-script-2")).toBeUndefined();
    setFocusedScripts("a", [dev]);
    setFocusedScripts("b", null); // another thread leaving doesn't clear a's
    expect(focusedScripts()).toEqual([dev]);
    setFocusedScripts("a", null);
    expect(focusedScripts()).toEqual([]);
  });
});

describe("script shortcuts", () => {
  it("⌥ with a digit reads the key's place, so ⌘⌥1 works on a Mac", async () => {
    const { comboOf, keysFor, IS_MAC } = await import("../src/lib/shortcuts.ts");
    const e = { key: "¡", code: "Digit1", altKey: true, metaKey: IS_MAC, ctrlKey: !IS_MAC, shiftKey: false };
    expect(comboOf(e)).toBe("mod+alt+1");
    expect(keysFor("run-script-1", {})).toBe("mod+alt+1");
  });
});
