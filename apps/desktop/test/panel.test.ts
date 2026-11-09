import { describe, expect, it } from "vitest";
import { MAX_TERMINALS } from "@lemonlime/protocol";
import {
  activeTab,
  clampPanel,
  closeTab,
  emptyPanel,
  moveTab,
  newTerminal,
  openFile,
  openScript,
  panelBounds,
  PANEL_WIDTH,
  reopenTab,
  shortTitle,
  snapPanel,
  snapPoints,
  stepPanel,
  terminalLabel,
  type PanelState,
} from "../src/lib/panel.ts";
import { CSV_MAX_ROWS, fileKind, languageFor, looksBinary, parseCsv } from "../src/lib/filePreview.ts";

let r = 0;
const rand = () => `r${++r}`;

describe("panel tabs", () => {
  it("opens terminals numbered from 1, the first on the runner's default shell, up to the limit", () => {
    let s: PanelState = emptyPanel();
    s = newTerminal(s, rand)!;
    expect(s.tabs[0]).toMatchObject({ kind: "terminal", terminal: "main", n: 1 });
    expect(s.active).toBe("term:main");
    s = newTerminal(s, rand)!;
    expect(s.tabs[1]).toMatchObject({ terminal: "t-r1", n: 2 });
    // Closing 1 frees its number for the next one.
    s = closeTab(s, "term:main");
    s = newTerminal(s, rand)!;
    expect(s.tabs.map(t => (t.kind === "terminal" ? t.n : 0))).toEqual([2, 1]);
    while (s.tabs.length < MAX_TERMINALS) s = newTerminal(s, rand)!;
    expect(newTerminal(s, rand)).toBeNull();
  });

  it("opens a script's own terminal once, named after the script", () => {
    let s = openScript(emptyPanel(), { id: "dev", name: "Dev" })!;
    expect(s.tabs).toEqual([{ kind: "terminal", id: "term:script-dev", terminal: "script-dev", n: 1, script: "dev", label: "Dev" }]);
    s = openScript({ ...s, active: "changes" }, { id: "dev", name: "Dev" })!;
    expect(s.tabs).toHaveLength(1);
    expect(s.active).toBe("term:script-dev");
    expect(terminalLabel(s.tabs[0] as { n: number; label?: string }, "zsh", "~/code")).toBe("Dev");
    let full = emptyPanel();
    for (let i = 0; i < MAX_TERMINALS; i++) full = newTerminal(full, () => String(i))!;
    expect(openScript(full, { id: "dev", name: "Dev" })).toBeNull();
  });

  it("opens a file at a line, moving an open tab to the new line", () => {
    let s = openFile(emptyPanel(), "a.ts", 12);
    expect(s.tabs).toEqual([{ kind: "file", id: "file:a.ts", path: "a.ts", line: 12 }]);
    s = openFile({ ...s, active: "changes" }, "a.ts", 40);
    expect(s.tabs).toEqual([{ kind: "file", id: "file:a.ts", path: "a.ts", line: 40 }]);
    expect(s.active).toBe("file:a.ts");
  });

  it("opens a file once, closes to the neighbour, and reopens the last closed tab", () => {
    let s = openFile(openFile(openFile(emptyPanel(), "a.ts"), "b.ts"), "c.ts");
    expect(openFile(s, "a.ts").tabs).toHaveLength(3);
    expect(openFile(s, "a.ts").active).toBe("file:a.ts");
    s = { ...s, active: "file:b.ts" };
    s = closeTab(s, "file:b.ts");
    expect(s.active).toBe("file:c.ts"); // the one to its right
    s = closeTab(s, "file:c.ts");
    expect(s.active).toBe("file:a.ts"); // nothing right: the left one
    s = closeTab(s, "file:a.ts");
    expect(s.active).toBe("changes");
    expect(s.closed.map(t => t.id)).toEqual(["file:b.ts", "file:c.ts", "file:a.ts"]);
    s = reopenTab(s);
    expect(s.tabs.map(t => t.id)).toEqual(["file:a.ts"]);
    expect(s.active).toBe("file:a.ts");
    s = reopenTab(reopenTab(s));
    expect(s.tabs.map(t => t.id)).toEqual(["file:a.ts", "file:c.ts", "file:b.ts"]);
    expect(reopenTab(s)).toEqual(s);
  });

  it("keeps only the last few closed tabs, and reorders tabs", () => {
    let s = emptyPanel();
    for (let i = 0; i < 15; i++) s = closeTab(openFile(s, `f${i}`), `file:f${i}`);
    expect(s.closed).toHaveLength(10);
    expect(s.closed.at(-1)?.id).toBe("file:f14");
    s = openFile(openFile(openFile(emptyPanel(), "a"), "b"), "c");
    expect(moveTab(s, "file:c", 0).tabs.map(t => t.id)).toEqual(["file:c", "file:a", "file:b"]);
    expect(moveTab(s, "file:a", 99).tabs.map(t => t.id)).toEqual(["file:b", "file:c", "file:a"]);
    expect(activeTab({ ...s, active: "gone" })).toBe("changes");
    expect(activeTab({ ...s, active: "browser" })).toBe("browser");
  });

  it("a reopened terminal takes a free number", () => {
    let s = newTerminal(newTerminal(emptyPanel(), rand)!, rand)!;
    s = closeTab(s, "term:main");
    s = newTerminal(s, rand)!; // takes number 1 again
    s = reopenTab(s);
    const nums = s.tabs.map(t => (t.kind === "terminal" ? t.n : 0));
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("names terminals by the shell's title, or shell and number", () => {
    expect(terminalLabel({ n: 1 }, "zsh", undefined)).toBe("zsh");
    expect(terminalLabel({ n: 3 }, "bash", "")).toBe("bash 3");
    expect(terminalLabel({ n: 2 }, undefined, undefined)).toBe("Terminal 2");
    expect(terminalLabel({ n: 2 }, "zsh", "hamed@mac: ~/code/lemonlime")).toBe("lemonlime");
    expect(shortTitle("me@host: ~")).toBe("~");
    expect(shortTitle("vim")).toBe("vim");
  });
});

describe("panel width", () => {
  it("leaves the conversation room and still fits the smallest window", () => {
    // The smallest window (900) minus the sidebar (288).
    const smallest = 900 - 288;
    const b = panelBounds(smallest);
    expect(b.min).toBe(PANEL_WIDTH.min);
    expect(b.max).toBeGreaterThanOrEqual(PANEL_WIDTH.min);
    expect(smallest - clampPanel(5000, smallest)).toBeGreaterThanOrEqual(PANEL_WIDTH.conversationMin);
    expect(clampPanel(100, 1600)).toBe(320);
    expect(clampPanel(600, 1600)).toBe(600);
    expect(clampPanel(5000, 1600)).toBe(1600 - 290);
    expect(clampPanel(5000, 3000)).toBe(PANEL_WIDTH.max);
    // Even narrower than that, the panel shrinks rather than covering the conversation.
    expect(clampPanel(500, 500)).toBe(PANEL_WIDTH.floor);
  });

  it("snaps gently to 320, 440, 640 and half the window", () => {
    expect(snapPoints(1600, 1888)).toEqual([320, 440, 640, 944]);
    expect(snapPoints(612, 900)).toEqual([320]);
    expect(snapPanel(450, 1600, 1888)).toBe(440);
    expect(snapPanel(430, 1600, 1888)).toBe(440);
    expect(snapPanel(470, 1600, 1888)).toBe(470); // too far: stays where it was dragged
    expect(snapPanel(935, 1600, 1888)).toBe(944);
    expect(snapPanel(100, 1600, 1888)).toBe(320);
  });

  it("steps between snap points from the keyboard", () => {
    expect(stepPanel(440, 1, 1600, 1888)).toBe(640);
    expect(stepPanel(500, -1, 1600, 1888)).toBe(440);
    expect(stepPanel(944, 1, 1600, 1888)).toBe(1310);
    expect(stepPanel(1310, 1, 1600, 1888)).toBe(1310);
    expect(stepPanel(320, -1, 1600, 1888)).toBe(320);
  });
});

describe("file previews", () => {
  it("knows each kind of file and its language", () => {
    expect(fileKind("a/b.PNG")).toBe("image");
    expect(fileKind("data.csv")).toBe("csv");
    expect(fileKind("doc.pdf")).toBe("pdf");
    expect(fileKind("song.mp3")).toBe("audio");
    expect(fileKind("src/main.rs")).toBe("text");
    expect(fileKind("Makefile")).toBe("text");
    expect(fileKind("lib.wasm")).toBe("binary");
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("Dockerfile")).toBe("docker");
    expect(languageFor("include/x.h")).toBe("c");
    expect(languageFor("README")).toBe("");
    expect(looksBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain"))).toBe(false);
  });

  it("reads CSV with quotes, commas and line breaks inside cells", () => {
    const { rows, truncated } = parseCsv('﻿name,note\r\nAda,"says ""hi"", twice"\nBob,"two\nlines"\n\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Ada", 'says "hi", twice'],
      ["Bob", "two\nlines"],
    ]);
    expect(truncated).toBe(false);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("x,y").rows).toEqual([["x", "y"]]);
    const many = Array.from({ length: CSV_MAX_ROWS + 5 }, (_, i) => `${i},v`).join("\n");
    const cut = parseCsv(many);
    expect(cut.rows).toHaveLength(CSV_MAX_ROWS);
    expect(cut.truncated).toBe(true);
  });
});
