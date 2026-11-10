import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTheme } from "../src/lib/theme.ts";
import { UiPrefs } from "../src/lib/storage.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("theme", () => {
  it("follows the system unless a theme is chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("defaults to the system, and survives a bad saved value", () => {
    expect(UiPrefs.parse({}).theme).toBe("system");
    expect(UiPrefs.parse({ theme: "sepia" }).theme).toBe("system");
  });

  it("is white in light mode and black in dark mode", () => {
    expect(css).toMatch(/--color-cream: #ffffff;/);
    const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(dark).toMatch(/--color-cream: #000000;/);
    expect(dark).toMatch(/--color-ink: #f4f4f1;/);
  });
});
