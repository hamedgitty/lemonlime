import { describe, expect, it } from "vitest";
import { betterTitle, cleanTitle, isVagueTitle, legacyTitle } from "../src/lib/threadTitle.ts";

describe("thread titles from the first message", () => {
  it("drops greetings and polite filler", () => {
    expect(cleanTitle("Hey, can you please fix the flaky login test?")).toBe("Fix the flaky login test");
    expect(cleanTitle("could you add dark mode to the settings page thanks")).toBe("Add dark mode to the settings");
    expect(cleanTitle("I want you to refactor the billing module")).toBe("Refactor the billing module");
  });

  it("keeps about six words and never ends on a little word", () => {
    expect(cleanTitle("Look through this repository for a real bug, explain it, fix it, and add a test")).toBe("Look through this repository");
    expect(cleanTitle("Rewrite the parser so that it handles nested quotes and escapes correctly")).toBe("Rewrite the parser");
    expect(cleanTitle("Add tests for the date helpers").split(" ").length).toBeLessThanOrEqual(6);
  });

  it("skips a vague opening line for the first one that says something", () => {
    expect(cleanTitle("hi!\nThe sidebar crashes when a project folder is missing")).toBe("The sidebar crashes when a project");
    expect(cleanTitle("Hello there. Upgrade React to the latest version.")).toBe("Upgrade React to the latest version");
  });

  it("leaves code, quotes, links and markup out", () => {
    expect(cleanTitle("```\nerror: boom\n```\nWhy does `pnpm build` fail?")).toBe("Why does pnpm build fail");
    expect(cleanTitle("> some quoted log\nExplain this error")).toBe("Explain this error");
    expect(cleanTitle("Read [the docs](https://example.com/x) and summarise them")).toBe("Read the docs and summarise them");
    expect(cleanTitle("Check @src/app.ts for leaks")).toBe("Check src/app.ts for leaks");
  });

  it("uses what follows a slash command, or the command itself", () => {
    expect(cleanTitle("/review the payment flow")).toBe("The payment flow");
    expect(cleanTitle("/security-review")).toBe("Security review");
  });

  it("falls back to the first line when nothing is left", () => {
    expect(cleanTitle("hi")).toBe("Hi");
    expect(cleanTitle("   ")).toBe("");
  });

  it("knows a vague title", () => {
    for (const t of ["Hi", "hey!", "Fix this", "continue", "Help me", "ok", "?", "heyyy"]) expect(isVagueTitle(t)).toBe(true);
    for (const t of ["Fix the flaky login test", "Upgrade React", "Explain auth"]) expect(isVagueTitle(t)).toBe(false);
  });
});

describe("renaming vague thread titles", () => {
  it("renames a vague title from the first later message that says more", () => {
    expect(betterTitle("Hi", ["hi", "ok", "Please migrate the database to Postgres"])).toBe("Migrate the database to Postgres");
  });

  it("works for titles made the old way too", () => {
    expect(betterTitle(legacyTitle("fix this"), ["fix this", "The upload button does nothing on Safari"])).toBe("The upload button does nothing");
  });

  it("leaves clear titles, titles typed by hand, and threads with nothing better alone", () => {
    expect(betterTitle("Fix the flaky login test", ["fix the flaky login test", "now run it"])).toBeNull();
    expect(betterTitle("Hi", ["Fix the cache", "Explain the router"])).toBeNull();
    expect(betterTitle("Hi", ["hi"])).toBeNull();
    expect(betterTitle("Hi", ["hi", "thanks", "ok"])).toBeNull();
  });
});
