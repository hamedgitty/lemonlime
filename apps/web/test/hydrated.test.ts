import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dateLocale, useHydrated } from "../src/lib/hydrated.ts";

describe("what only the browser knows", () => {
  it("is left out of the page the server sends", () => {
    const Probe = () => createElement("p", null, useHydrated() ? "browser" : "server");
    expect(renderToString(createElement(Probe))).toBe("<p>server</p>");
  });

  it("writes dates one fixed way until the browser has taken over, then the reader's way", () => {
    expect(dateLocale(false)).toBe("en-US");
    expect(dateLocale(true)).toBeUndefined();
  });

  it("writes a time the same on any machine while that fixed way is in use", () => {
    const at = new Date("2026-11-10T14:05:00Z");
    const written = at.toLocaleString(dateLocale(false), { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "Europe/Paris" });
    expect(written.replace(/\s/g, " ")).toBe("Tue 3:05 PM");
  });
});
