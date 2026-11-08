import { describe, expect, it } from "vitest";
import { shortPath, summarizeToolInput } from "../src/lib/format.ts";

describe("tool row summaries", () => {
  it("keep short paths as they are", () => {
    expect(shortPath("src/app/page.tsx")).toBe("src/app/page.tsx");
  });

  it("keep the end of a long path, so the file's name shows", () => {
    const long = "/Users/someone/.lemonlime/worktrees/shop/th-login01/packages/web/src/app/checkout/page.tsx";
    const short = shortPath(long);
    expect(short.startsWith("…/")).toBe(true);
    expect(short.endsWith("checkout/page.tsx")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(48);
  });

  it("never drop the file name, however long", () => {
    const name = "a".repeat(80) + ".ts";
    expect(shortPath(`/x/y/${name}`)).toBe(`…/${name}`);
  });

  it("shorten a path past the one-line limit from its start, not its end", () => {
    const path = `/${"deep/".repeat(40)}repo/sum.js`;
    expect(summarizeToolInput({ file_path: path })).toBe("…/" + "deep/".repeat(7) + "repo/sum.js");
  });

  it("shorten file paths but not commands", () => {
    const path = "/private/tmp/some/very/long/folder/that/goes/on/and/on/repo/sum.js";
    expect(summarizeToolInput({ file_path: path })).toMatch(/^…\/.*repo\/sum\.js$/);
    expect(summarizeToolInput({ command: "node test.js" })).toBe("node test.js");
  });
});
