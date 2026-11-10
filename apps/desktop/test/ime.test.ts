import { describe, expect, it } from "vitest";
import { composing } from "../src/lib/ime";

describe("typing with an input method", () => {
  it("knows a key press that is still composing", () => {
    expect(composing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
    expect(composing({ isComposing: true })).toBe(true);
  });

  it("catches the Enter that WebKit reports as finished", () => {
    expect(composing({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });

  it("leaves ordinary keys alone", () => {
    expect(composing({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(composing({})).toBe(false);
  });
});
