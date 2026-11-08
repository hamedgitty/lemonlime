import { describe, expect, it } from "vitest";
import { dictationError, joinDictation } from "../src/lib/dictation.ts";

describe("voice input", () => {
  it("adds phrases with one space between", () => {
    expect(joinDictation("", " fix the login test ")).toBe("fix the login test");
    expect(joinDictation("Please", "fix it")).toBe("Please fix it");
    expect(joinDictation("Line one\n", "line two")).toBe("Line one\nline two");
    expect(joinDictation("Keep this", "   ")).toBe("Keep this");
  });

  it("stays quiet about silence and stops, and explains real problems", () => {
    expect(dictationError("no-speech")).toBeNull();
    expect(dictationError("aborted")).toBeNull();
    expect(dictationError("not-allowed")).toMatch(/microphone/);
    expect(dictationError("audio-capture")).toMatch(/No microphone/);
    expect(dictationError("something-new")).toMatch(/Try again/);
  });
});
