import { describe, expect, it } from "vitest";
import { dictationError, joinDictation, levelFromSamples, micOptions } from "../src/lib/dictation.ts";

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

describe("the dictation level meter", () => {
  it("reads silence as nothing and a loud voice as most of the meter", () => {
    expect(levelFromSamples(new Uint8Array(512).fill(128))).toBe(0);
    const loud = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 200 : 56));
    expect(levelFromSamples(loud)).toBeGreaterThan(0.8);
    expect(levelFromSamples([])).toBe(0);
  });

  it("offers the system default first, then each microphone by name", () => {
    expect(
      micOptions([
        { deviceId: "default", label: "Default" },
        { deviceId: "abc", label: "Studio mic" },
        { deviceId: "def", label: "" },
      ]),
    ).toEqual([
      { value: "", label: "System default" },
      { value: "abc", label: "Studio mic" },
      { value: "def", label: "Microphone 2" },
    ]);
  });
});
