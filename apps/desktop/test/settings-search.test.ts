import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorOf, groupByPage, searchSettings, SETTINGS_INDEX } from "../src/lib/settingsIndex.ts";
import { clearShortcut, keysFor, matchShortcut, resetShortcut, setShortcut } from "../src/lib/shortcuts.ts";

const PAGES = ["account", "general", "agents", "instructions", "cloud", "machines", "projects", "appearance", "keyboard", "updates"];
const settingsDir = join(__dirname, "../src/components/settings");
const source = readdirSync(settingsDir)
  .map(f => readFileSync(join(settingsDir, f), "utf8"))
  .concat(readFileSync(join(__dirname, "../src/lib/shortcuts.ts"), "utf8"))
  .join("\n");

describe("settings search", () => {
  it("finds options, not just pages", () => {
    const hits = searchSettings("co-author");
    expect(hits.map(h => `${h.page}:${h.tab}`)).toEqual(["agents:defaults", "cloud:environment"]);
    expect(searchSettings("microphone")[0]).toMatchObject({ page: "general", tab: "general", title: "Microphone" });
    expect(searchSettings("dark")[0]).toMatchObject({ page: "appearance", title: "Colours" });
  });

  it("needs every word, and puts title matches first", () => {
    expect(searchSettings("keep screen").map(h => h.title)).toEqual(["Keep the screen on too"]);
    expect(searchSettings("effort").map(h => h.title)).toEqual([
      "Offer the highest effort levels",
      "Claude Code effort",
      "Codex effort",
      "Cycle the agent's effort, in the message box",
    ]);
    // A word only in the keywords ranks below the titles that have it.
    const agents = searchSettings("agents").map(h => h.title);
    expect(agents.indexOf("Harness")).toBeGreaterThan(agents.indexOf("ACP agents"));
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("zzzz nothing")).toEqual([]);
  });

  it("groups matches under their page, in the pages' order", () => {
    const grouped = groupByPage(searchSettings("limit"), PAGES);
    expect(grouped.map(gr => gr.page)).toEqual(["agents", "cloud"]);
    expect(grouped[0]!.entries.every(e => e.page === "agents")).toBe(true);
  });

  it("points every option at a real page, and at a row that page draws", () => {
    for (const e of SETTINGS_INDEX) {
      expect(PAGES).toContain(e.page);
      // Rows take their anchor from their label or title, or say it with `anchor="…"`.
      expect(source.includes(`"${anchorOf(e)}"`) || source.includes(`\`${anchorOf(e)}`), `${e.page}: ${anchorOf(e)}`).toBe(true);
    }
  });
});

describe("turning a shortcut off", () => {
  const key = (k: string) => ({ key: k, metaKey: true, ctrlKey: true, shiftKey: false, altKey: false }) as KeyboardEvent;

  it("keeps it off until it's reset", () => {
    const off = clearShortcut({}, "new-thread");
    expect(keysFor("new-thread", off)).toBe("");
    expect(matchShortcut(key("n"), off)).toBeNull();
    expect(keysFor("new-thread", resetShortcut(off, "new-thread"))).toBe("mod+n");
  });

  it("forgets an override that is the default again", () => {
    const moved = setShortcut({}, "new-thread", "mod+shift+n");
    expect(moved).toEqual({ "new-thread": "mod+shift+n" });
    expect(setShortcut(moved, "new-thread", "mod+n")).toEqual({});
  });
});
