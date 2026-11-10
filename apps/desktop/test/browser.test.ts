import { describe, expect, it } from "vitest";
import {
  HISTORY_KEPT,
  addRecent,
  canGoBack,
  canGoForward,
  currentAddress,
  goBack,
  goForward,
  normalizeUrl,
  panelAddress,
  shortAddress,
  startHistory,
  visit,
} from "../src/lib/browser.ts";

describe("panel browser history", () => {
  it("goes back and forward through the addresses opened", () => {
    let h = startHistory("http://localhost:3000/");
    expect(canGoBack(h)).toBe(false);
    h = visit(h, "http://localhost:3000/a");
    h = visit(h, "http://localhost:3000/b");
    expect(currentAddress(h)).toBe("http://localhost:3000/b");
    h = goBack(goBack(h));
    expect(currentAddress(h)).toBe("http://localhost:3000/");
    expect(canGoBack(h)).toBe(false);
    expect(goBack(h)).toBe(h);
    h = goForward(h);
    expect(currentAddress(h)).toBe("http://localhost:3000/a");
    expect(canGoForward(h)).toBe(true);
  });

  it("drops the pages ahead when a new one is opened after going back", () => {
    let h = visit(visit(startHistory("a"), "b"), "c");
    h = visit(goBack(goBack(h)), "d");
    expect(h.entries).toEqual(["a", "d"]);
    expect(canGoForward(h)).toBe(false);
  });

  it("ignores opening the page it is on, and keeps a bounded history", () => {
    const h = startHistory("a");
    expect(visit(h, "a")).toBe(h);
    let long = h;
    for (let i = 0; i < HISTORY_KEPT + 10; i++) long = visit(long, `p${i}`);
    expect(long.entries).toHaveLength(HISTORY_KEPT);
    expect(currentAddress(long)).toBe(`p${HISTORY_KEPT + 9}`);
  });
});

describe("recent addresses", () => {
  it("puts the newest first, each once, at most a few", () => {
    expect(addRecent(["http://localhost:3000/", "https://example.com/"], "http://localhost:3000")).toEqual(["http://localhost:3000", "https://example.com/"]);
    const many = Array.from({ length: 12 }, (_, i) => `http://localhost:${3000 + i}/`);
    const kept = many.reduce<string[]>((list, u) => addRecent(list, u), []);
    expect(kept).toHaveLength(8);
    expect(kept[0]).toBe("http://localhost:3011/");
  });

  it("shows an address the way you'd type it", () => {
    expect(shortAddress("http://localhost:3000/")).toBe("localhost:3000");
    expect(shortAddress("https://example.com/docs/?q=1")).toBe("example.com/docs/?q=1");
    expect(shortAddress("not a url")).toBe("not a url");
  });

  it("turns what was typed into an address", () => {
    expect(normalizeUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
    expect(normalizeUrl("[::1]:8080")).toBe("http://[::1]:8080/");
    expect(normalizeUrl("docs.example.com")).toBe("https://docs.example.com/");
    expect(normalizeUrl("  ")).toBeNull();
  });

  it("shows only pages served from this computer in a panel", () => {
    expect(panelAddress("http://localhost:3000/app?tab=1")).toBe("http://localhost:3000/app?tab=1");
    expect(panelAddress("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    // The same computer under a name the panel can't show.
    expect(panelAddress("http://[::1]:8080/docs")).toBe("http://localhost:8080/docs");
    expect(panelAddress("https://example.com/")).toBeNull();
    expect(panelAddress("http://example.com/")).toBeNull();
    expect(panelAddress("https://localhost:3000/")).toBeNull();
    expect(panelAddress("http://localhost.example.com/")).toBeNull();
    expect(panelAddress("not a url")).toBeNull();
  });
});

describe("find in page and preview paths", async () => {
  const { countMatches, sameOrigin } = await import("../src/components/PanelBrowser.tsx");
  const { localPort, previewPath } = await import("../src/components/PreviewPanel.tsx");

  it("counts matches ignoring case, without overlaps", () => {
    expect(countMatches("Save the file. SAVE it again.", "save")).toBe(2);
    expect(countMatches("aaaa", "aa")).toBe(2);
    expect(countMatches("text", "")).toBe(0);
  });

  it("only searches pages from the app's own origin", () => {
    expect(sameOrigin("http://localhost:1444/docs", "http://localhost:1444/")).toBe(true);
    expect(sameOrigin("http://localhost:3000/", "tauri://localhost/")).toBe(false);
    expect(sameOrigin("https://example.com/", "http://localhost:1444/")).toBe(false);
    expect(sameOrigin("not a url", "http://localhost:1444/")).toBe(false);
  });

  it("keeps the path of what was typed for a preview", () => {
    expect(previewPath("settings")).toBe("/settings");
    expect(previewPath("")).toBe("/");
    expect(previewPath("http://localhost:5173/a?b=1")).toBe("/a?b=1");
    expect(previewPath("127.0.0.1:4000")).toBe("/");
  });

  it("reads the port of a local address", () => {
    expect(localPort("http://localhost:5173/app")).toBe(5173);
    expect(localPort("http://127.0.0.1/")).toBe(80);
    expect(localPort("https://example.com:5173/")).toBeNull();
    expect(localPort("nope")).toBeNull();
  });
});
