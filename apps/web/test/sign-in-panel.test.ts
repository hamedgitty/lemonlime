import { describe, expect, it } from "vitest";
import { secureLink } from "../src/app/(app)/threads/[id]/sign-in-panel.tsx";

describe("the sign-in link a sandbox sends", () => {
  it("is only offered when it is a secure web link", () => {
    expect(secureLink("https://example.com/device?code=ABCD")).toBe("https://example.com/device?code=ABCD");
    for (const bad of [
      undefined,
      "",
      "http://example.com/device",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///etc/hosts",
      "//example.com",
      "not a link",
    ]) {
      expect(secureLink(bad), String(bad)).toBeNull();
    }
  });
});
