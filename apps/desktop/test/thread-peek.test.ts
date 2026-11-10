import { describe, expect, it } from "vitest";
import { floatingOpen } from "../src/lib/typeAnywhere.ts";

/** A page holding these elements, found by their role the way a selector would find them. */
const page = (...elements: { role: string; shown?: boolean }[]) =>
  ({
    querySelectorAll: (selector: string) =>
      elements.filter(e => selector.includes(`[role="${e.role}"]`)).map(e => ({ getClientRects: () => (e.shown === false ? [] : [{}]) })),
  }) as unknown as Document;

describe("what keeps the thread hover card away", () => {
  it("is nothing on a page with no dialog or menu", () => {
    expect(floatingOpen(page())).toBe(false);
    expect(floatingOpen(page({ role: "tooltip" }, { role: "status" }))).toBe(false);
  });

  it("is an open dialog, such as the command palette or a popover", () => {
    expect(floatingOpen(page({ role: "dialog" }))).toBe(true);
    expect(floatingOpen(page({ role: "alertdialog" }))).toBe(true);
  });

  it("is an open menu, such as the one a right click on the row brings up", () => {
    expect(floatingOpen(page({ role: "menu" }))).toBe(true);
  });

  it("is not a dialog that is in the page but isn't showing", () => {
    expect(floatingOpen(page({ role: "dialog", shown: false }))).toBe(false);
    expect(floatingOpen(page({ role: "dialog", shown: false }, { role: "menu" }))).toBe(true);
  });

  it("is not a list that is part of the page itself", () => {
    expect(floatingOpen(page({ role: "listbox" }))).toBe(false);
  });
});
