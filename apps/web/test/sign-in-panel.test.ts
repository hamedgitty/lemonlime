import { describe, expect, it } from "vitest";
import { safeLink } from "../src/lib/links.ts";

describe("the sign-in link a sandbox sends", () => {
  it("is only offered when it is a secure web link", () => {
    expect(safeLink("https://example.com/device?code=ABCD")).toBe("https://example.com/device?code=ABCD");
    for (const bad of [
      undefined,
      null,
      "",
      "http://example.com/device",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,hello",
      "file:///etc/hosts",
      "mailto:someone@example.com",
      "//example.com",
      "/settings",
      "not a link",
    ]) {
      expect(safeLink(bad), String(bad)).toBeNull();
    }
  });

  it("may be a plain web link when it points at this computer", () => {
    for (const local of ["http://localhost:1455/callback?code=ABCD", "http://127.0.0.1:8080/", "http://[::1]:8080/", "http://app.localhost/done"]) {
      expect(safeLink(local), local).toBe(local);
    }
    // Names that only look like this computer.
    for (const elsewhere of [
      "http://localhost.example.com/",
      "http://127.0.0.1.example.com/",
      "http://example.com/?next=localhost",
      "http://localhost@example.com/",
    ]) {
      expect(safeLink(elsewhere), elsewhere).toBeNull();
    }
  });
});
