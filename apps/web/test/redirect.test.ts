import { describe, expect, it } from "vitest";
import { loginUrl, safeNext } from "../src/lib/auth.ts";

describe("post-login destination", () => {
  it("keeps same-site paths, including query and hash", () => {
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("/threads/abc123?tab=diff#e-12")).toBe("/threads/abc123?tab=diff#e-12");
    expect(safeNext("/")).toBe("/");
  });

  it("falls back to / for anything that could leave the site", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "settings",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example", // browsers drop the tab, leaving //evil.example
      "/\n/evil.example",
      "/\r/evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeNext(bad), String(bad)).toBe("/");
    }
  });

  it("normalises paths that only look odd but stay on the site", () => {
    expect(safeNext("/a/../settings")).toBe("/settings");
    expect(safeNext("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });

  it("builds the login URL that returns to the page", () => {
    expect(loginUrl("/threads/abc123")).toBe("/login?next=%2Fthreads%2Fabc123");
    expect(loginUrl("/")).toBe("/login");
    expect(loginUrl("//evil.example")).toBe("/login");
  });
});
