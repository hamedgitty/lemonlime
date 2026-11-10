import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingAnchor, groupByPage, findSettings, SETTINGS_INDEX } from "../src/lib/settingsIndex.ts";
import { rowShortcut, turnOffShortcut, keysFor, matchShortcut, resetShortcut, setShortcut } from "../src/lib/shortcuts.ts";

const PAGES = ["account", "general", "agents", "instructions", "cloud", "machines", "projects", "appearance", "keyboard", "updates"];
const settingsDir = join(__dirname, "../src/components/settings");
const source = readdirSync(settingsDir)
  .map(f => readFileSync(join(settingsDir, f), "utf8"))
  .concat(readFileSync(join(__dirname, "../src/lib/shortcuts.ts"), "utf8"))
  .join("\n");

describe("settings search", () => {
  it("finds options, not just pages", () => {
    const hits = findSettings("co-author");
    expect(hits.map(h => `${h.page}:${h.tab}`)).toEqual(["agents:defaults", "cloud:environment"]);
    expect(findSettings("microphone")[0]).toMatchObject({ page: "general", tab: "general", title: "Microphone" });
    expect(findSettings("dim panes")[0]).toMatchObject({ page: "appearance", title: "Dim inactive panes in split view" });
    expect(findSettings("dark mode")[0]).toMatchObject({ page: "appearance", title: "Theme" });
  });

  it("needs every word, and puts title matches first", () => {
    expect(findSettings("keep screen").map(h => h.title)).toEqual(["Keep the screen on too"]);
    expect(findSettings("effort").map(h => h.title)).toEqual([
      "Offer the highest effort levels",
      "Claude Code effort",
      "Codex effort",
      "Cycle the agent's effort, in the message box",
    ]);
    // A word only in the keywords ranks below the titles that have it.
    const agents = findSettings("agents").map(h => h.title);
    expect(agents.indexOf("Harness")).toBeGreaterThan(agents.indexOf("ACP agents"));
    expect(findSettings("")).toEqual([]);
    expect(findSettings("zzzz nothing")).toEqual([]);
  });

  it("groups matches under their page, in the pages' order", () => {
    const grouped = groupByPage(findSettings("limit"), PAGES);
    expect(grouped.map(gr => gr.page)).toEqual(["agents", "cloud"]);
    expect(grouped[0]!.entries.every(e => e.page === "agents")).toBe(true);
  });

  it("points every option at a real page, and at a row that page draws", () => {
    for (const e of SETTINGS_INDEX) {
      expect(PAGES).toContain(e.page);
      // Rows take their anchor from their label or title, or say it with `anchor="…"`.
      expect(source.includes(`"${settingAnchor(e)}"`) || source.includes(`\`${settingAnchor(e)}`), `${e.page}: ${settingAnchor(e)}`).toBe(true);
    }
  });
});

describe("turning a shortcut off", () => {
  const key = (k: string) => ({ key: k, metaKey: true, ctrlKey: true, shiftKey: false, altKey: false }) as KeyboardEvent;

  it("keeps it off until it's reset", () => {
    const off = turnOffShortcut({}, "new-thread");
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

describe("⌘1–9 for the sidebar's threads", () => {
  it("uses the pane keys for the first six rows and keys of their own for the rest", () => {
    expect(rowShortcut(1)).toBe("focus-pane-1");
    expect(rowShortcut(6)).toBe("focus-pane-6");
    expect(rowShortcut(7)).toBe("sidebar-thread-7");
    expect(rowShortcut(9)).toBe("sidebar-thread-9");
    expect(rowShortcut(0)).toBeNull();
    expect(rowShortcut(10)).toBeNull();
    expect(keysFor(rowShortcut(9)!, {})).toBe("mod+9");
  });
});
