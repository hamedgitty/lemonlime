import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/lib/diff.ts";

describe("parseUnifiedDiff", () => {
  it("classifies lines and numbers them", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,3 +10,4 @@ function x() {",
      " keep",
      "-old",
      "+new",
      "+extra",
      " tail",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const p = parseUnifiedDiff(diff);
    expect(p.additions).toBe(2);
    expect(p.deletions).toBe(1);
    expect(p.lines.map(l => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "context", "del", "add", "add", "context", "note"]);
    const byText = Object.fromEntries(p.lines.map(l => [l.text, [l.oldNo, l.newNo]]));
    expect(byText[" keep"]).toEqual([10, 10]);
    expect(byText["-old"]).toEqual([11, null]);
    expect(byText["+new"]).toEqual([null, 11]);
    expect(byText["+extra"]).toEqual([null, 12]);
    expect(byText[" tail"]).toEqual([12, 13]);
  });

  it("does not count file headers as changes", () => {
    const p = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n");
    expect([p.additions, p.deletions]).toEqual([1, 1]);
  });
});
