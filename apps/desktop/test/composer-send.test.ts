import { describe, expect, it } from "vitest";
import { sendBlocker, sendRoute } from "../src/lib/composerSend.ts";

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
