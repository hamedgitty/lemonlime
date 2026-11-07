import { describe, expect, it } from "vitest";
import { answerComputerRequest, decide, describeRequest, shownExactly } from "../src/lib/computer.ts";

describe("computer access", () => {
  it("follows the thread's setting", () => {
    const read = { op: "read_file" as const, path: "/Users/me/a.txt" };
    const run = { op: "run_command" as const, command: "ls" };
    expect([decide("off", read), decide("read", read), decide("read", run), decide("ask", run), decide("full", run)]).toEqual([
      "refuse",
      "allow",
      "refuse",
      "ask",
      "allow",
    ]);
  });

  it("shows hidden and look-alike characters as escapes", () => {
    // Cyrillic "а" looks like Latin "a"; U+202E reverses text; U+200B is invisible.
    expect(shownExactly("rm -rf /tmp/аpp‮​\n")).toBe("rm -rf /tmp/\\u{430}pp\\u{202e}\\u{200b}\\n");
    expect(describeRequest({ op: "run_command", command: "echo\tok", cwd: "/tmp" })).toBe("Run this command in /tmp:\n\necho\\tok");
  });

  it("refuses without asking when the setting says no, and respects a no", async () => {
    let asked = 0;
    const ask = async () => (asked++, false);
    expect(await answerComputerRequest("off", { op: "read_file", path: "/x" }, ask)).toMatchObject({ ok: false });
    expect(await answerComputerRequest("read", { op: "run_command", command: "ls" }, ask)).toMatchObject({ ok: false, output: /only read/ });
    expect(asked).toBe(0);
    expect(await answerComputerRequest("ask", { op: "run_command", command: "ls" }, ask)).toEqual({ ok: false, output: "The user said no." });
    expect(asked).toBe(1);
  });
});
