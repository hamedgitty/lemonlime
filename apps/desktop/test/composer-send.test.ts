import { describe, expect, it } from "vitest";
import { enterAction, sendBlocker, sendKeyLabel, sendRoute } from "../src/lib/composerSend.ts";
import { attachmentLabel, MESSAGE_MAX_CHARS, PASTE_AS_FILE_BYTES, pasteBecomesFile, pastedTextName } from "../src/lib/pastedText.ts";
import { pasteGoesToComposer, typingGoesToComposer } from "../src/lib/typeAnywhere.ts";
import { encodePlan, fitWithin, IMAGE_MAX_BYTES, needsShrinking, renameFor } from "../src/lib/imageShrink.ts";

describe("sending from the composer", () => {
  it("keeps the message while files are still uploading", () => {
    expect(sendBlocker({ uploading: true })).toMatch(/finish uploading/);
    expect(sendBlocker({ uploading: false })).toBeNull();
  });

  it("only takes a message it has somewhere to send", () => {
    expect(sendRoute("hi", true, "local")).toBe("runner");
    expect(sendRoute("hi", true, "cloud")).toBe("runner");
    // A paused cloud thread wakes for it; a local thread with no runner can't take it.
    expect(sendRoute("hi", false, "cloud")).toBe("wake");
    expect(sendRoute("hi", false, "local")).toBeNull();
    expect(sendRoute("   ", true, "local")).toBeNull();
  });
});

describe("the send key", () => {
  const key = (mods: Partial<Record<"shiftKey" | "altKey" | "metaKey" | "ctrlKey", boolean>> = {}) => ({
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
  });

  it("sends on Enter by default, with Shift+Enter for a new line", () => {
    expect(enterAction(key(), "enter", "hi")).toBe("send");
    expect(enterAction(key({ shiftKey: true }), "enter", "hi")).toBe("newline");
    expect(enterAction(key({ altKey: true }), "enter", "hi")).toBe("hold");
    expect(enterAction(key({ metaKey: true }), "enter", "hi")).toBe("send");
  });

  it("can send on ⌘Enter only", () => {
    expect(enterAction(key(), "mod-enter", "hi")).toBe("newline");
    expect(enterAction(key({ metaKey: true }), "mod-enter", "hi")).toBe("send");
    expect(enterAction(key({ ctrlKey: true }), "mod-enter", "hi")).toBe("send");
  });

  it("can switch to ⌘Enter once the message has more than one line", () => {
    expect(enterAction(key(), "mod-enter-multiline", "one line")).toBe("send");
    expect(enterAction(key(), "mod-enter-multiline", "two\nlines")).toBe("newline");
    expect(enterAction(key({ metaKey: true }), "mod-enter-multiline", "two\nlines")).toBe("send");
    expect(sendKeyLabel("mod-enter-multiline", "two\nlines", "⌘")).toBe("⌘Enter");
    expect(sendKeyLabel("enter", "two\nlines", "⌘")).toBe("Enter");
  });
});

describe("long pastes", () => {
  it("attaches pastes over 32 KB, counted in UTF-8 bytes", () => {
    expect(pasteBecomesFile("short", 0)).toBe(false);
    expect(pasteBecomesFile("a".repeat(PASTE_AS_FILE_BYTES), 0)).toBe(false);
    expect(pasteBecomesFile("a".repeat(PASTE_AS_FILE_BYTES + 1), 0)).toBe(true);
    // Accented letters take two bytes each.
    expect(pasteBecomesFile("é".repeat(PASTE_AS_FILE_BYTES / 2 + 1), 0)).toBe(true);
  });

  it("attaches a paste that would push the box past its limit", () => {
    expect(pasteBecomesFile("a".repeat(100), MESSAGE_MAX_CHARS - 50)).toBe(true);
    expect(pasteBecomesFile("a".repeat(100), MESSAGE_MAX_CHARS - 50, 60)).toBe(false);
  });

  it("numbers pasted files and labels them", () => {
    expect(pastedTextName([])).toBe("pasted-text.txt");
    expect(pastedTextName(["pasted-text.txt", "pasted-text-2.txt"])).toBe("pasted-text-3.txt");
    expect(attachmentLabel("pasted-text.txt")).toBe("Pasted text");
    expect(attachmentLabel("pasted-text-2.txt")).toBe("Pasted text 2");
    expect(attachmentLabel("notes.txt")).toBe("notes.txt");
  });
});

describe("typing anywhere", () => {
  const free = { editable: false, control: false, terminal: false, overlay: false };
  const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });

  it("sends printable keys to the message box when nothing else takes them", () => {
    expect(typingGoesToComposer(press("a"), free)).toBe(true);
    expect(typingGoesToComposer(press("é"), free)).toBe(true);
    expect(typingGoesToComposer(press(" "), free)).toBe(false);
    expect(typingGoesToComposer(press("Enter"), free)).toBe(false);
    expect(typingGoesToComposer(press("k", { metaKey: true }), free)).toBe(false);
  });

  it("leaves fields, focused buttons, the terminal and open menus alone", () => {
    for (const f of ["editable", "control", "terminal", "overlay"] as const) {
      expect(typingGoesToComposer(press("a"), { ...free, [f]: true })).toBe(false);
      expect(pasteGoesToComposer({ ...free, [f]: true })).toBe(false);
    }
    expect(pasteGoesToComposer(free)).toBe(true);
  });
});

describe("shrinking images", () => {
  it("fits the longest side in 2000 px, keeping the shape", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(1200, 6000)).toEqual({ width: 400, height: 2000 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("leaves small images alone", () => {
    expect(needsShrinking(1800, 1200, 400_000)).toBe(false);
    expect(needsShrinking(2001, 10, 1000)).toBe(true);
    expect(needsShrinking(1000, 1000, IMAGE_MAX_BYTES + 1)).toBe(true);
  });

  it("keeps a PNG sharp first, then steps quality down", () => {
    const png = encodePlan("image/png");
    expect(png[0]).toEqual({ type: "image/png" });
    expect(png.slice(1).every(s => s.type !== "image/png")).toBe(true);
    const jpeg = encodePlan("image/jpeg").map(s => s.quality!);
    expect(jpeg).toEqual([...jpeg].sort((a, b) => b - a));
    expect(renameFor("shot.png", "image/jpeg")).toBe("shot.jpg");
    expect(renameFor("shot.png", "image/webp")).toBe("shot.webp");
  });
});
