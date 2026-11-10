import { describe, expect, it } from "vitest";
import { safeActionLink, safeLink, withSafeLink } from "../src/links.ts";

describe("a link offered next to a message", () => {
  it("may be a secure web page, or a page on this computer", () => {
    for (const good of ["https://example.com/settings#billing", "http://localhost:3000/settings", "http://127.0.0.1:3000/"]) {
      expect(safeActionLink(good), good).toBe(good);
    }
    for (const bad of [
      undefined,
      null,
      "",
      "http://example.com/settings",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///etc/hosts",
      "/settings",
      "not a link",
    ]) {
      expect(safeActionLink(bad), String(bad)).toBeNull();
    }
  });

  it("may be an email address to write to, with nothing filled in", () => {
    expect(safeActionLink("mailto:help@example.com")).toBe("mailto:help@example.com");
    for (const bad of [
      "mailto:",
      "mailto:help",
      "mailto:help@example.com?subject=Hello",
      "mailto:help@example.com?body=Send%20this",
      "mailto:help@example.com,other@example.com",
      "mailto:help@example.com?cc=other@example.com",
      "mailto:help%40example.com@example.com",
      "mailto:help@example.com other@example.com",
    ]) {
      expect(safeActionLink(bad), bad).toBeNull();
    }
  });

  it("is never an email address where only a web page makes sense", () => {
    expect(safeLink("mailto:help@example.com")).toBeNull();
  });

  it("takes its label with it when it is dropped", () => {
    expect(withSafeLink({ reason: "No.", actionUrl: "mailto:help@example.com", actionLabel: "Contact us" })).toEqual({
      reason: "No.",
      actionUrl: "mailto:help@example.com",
      actionLabel: "Contact us",
    });
    expect(withSafeLink({ reason: "No.", actionUrl: "http://example.com/why", actionLabel: "See why" })).toEqual({ reason: "No." });
    expect(withSafeLink({ reason: "No.", actionLabel: "See why" })).toEqual({ reason: "No." });
  });
});
