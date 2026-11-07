import { describe, expect, it } from "vitest";
import { joinCommand, splitCommand } from "../src/lib/command.ts";

describe("splitCommand / joinCommand", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(splitCommand("gemini  --experimental-acp")).toEqual(["gemini", "--experimental-acp"]);
    expect(splitCommand(`my-agent --name "two words" 'single q' a\\ b ""`)).toEqual(["my-agent", "--name", "two words", "single q", "a b", ""]);
  });

  it("round-trips through joinCommand", () => {
    const words = ["agent", "--flag", "with space", 'quo"te', ""];
    expect(splitCommand(joinCommand(words))).toEqual(words);
  });
});
