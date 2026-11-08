import { describe, expect, it } from "vitest";
import type { DiffHunk } from "@lemonlime/protocol";
import { fetchGitDiff, hiddenBefore, numberHunk, quoteLines, ReviewUnavailable, splitPath, splitRows } from "../src/lib/review.ts";
import { clampPanelWidth, THREAD_PANEL } from "../src/lib/storage.ts";

const hunk: DiffHunk = {
  header: "@@ -10,5 +10,6 @@ function x() {",
  oldStart: 10,
  oldLines: 5,
  newStart: 10,
  newLines: 6,
  lines: [" keep", "-old one", "-old two", "+new one", "+new two", "+new three", " tail", "\\ No newline at end of file"],
};

describe("diff lines", () => {
  it("numbers old and new lines", () => {
    const lines = numberHunk(hunk);
    expect(lines.map(l => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["del", 12, null],
      ["add", null, 11],
      ["add", null, 12],
      ["add", null, 13],
      ["context", 13, 14],
      ["note", null, null],
    ]);
    expect(lines[1]!.text).toBe("old one");
  });

  it("pairs removals with the additions after them side by side", () => {
    const rows = splitRows(numberHunk(hunk));
    expect(rows.map(r => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["keep", "keep"],
      ["old one", "new one"],
      ["old two", "new two"],
      [null, "new three"],
      ["tail", "tail"],
      ["\\ No newline at end of file", "\\ No newline at end of file"],
    ]);
  });

  it("counts lines hidden between hunks", () => {
    const second: DiffHunk = { ...hunk, oldStart: 40, newStart: 41, newLines: 3 };
    expect(hiddenBefore([hunk, second], 0)).toBe(9);
    expect(hiddenBefore([hunk, second], 1)).toBe(41 - 16);
    expect(hiddenBefore([{ ...hunk, newStart: 1 }], 0)).toBe(0);
  });

  it("quotes picked lines with file and line numbers for the chat", () => {
    const lines = numberHunk(hunk);
    expect(quoteLines("src/x.ts", lines.slice(3, 5))).toBe("src/x.ts:11-12\n```diff\n+new one\n+new two\n```\n");
    expect(quoteLines("src/x.ts", lines.slice(0, 1))).toBe("src/x.ts:10\n```diff\n keep\n```\n");
    // Removed lines only: old-file numbers.
    expect(quoteLines("a.md", lines.slice(1, 3))).toMatch(/^a\.md:11-12\n/);
    // A fence inside the code gets a longer fence around it.
    expect(quoteLines("a.md", [{ kind: "add", text: "```js", oldNo: null, newNo: 3 }])).toBe("a.md:3\n````diff\n+```js\n````\n");
    expect(quoteLines("a.md", [])).toBe("");
  });

  it("keeps the file name whole when splitting a path", () => {
    expect(splitPath("apps/desktop/src/components/ThreadView.tsx")).toEqual({ dir: "apps/desktop/src/components/", name: "ThreadView.tsx" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("runner review API", () => {
  const connection = { url: "ws://127.0.0.1:7420/ws", token: async () => "tok" };
  it("asks the runner over HTTP with the client token", async () => {
    let seen = "";
    let auth = "";
    const body = { scope: "commit", commit: "abc1234", base: "def", files: [], moreFiles: 0, commits: [] };
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = url;
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const r = await fetchGitDiff(connection, { scope: "commit", commit: "abc1234", path: "a b.ts", context: 20 }, fetchImpl);
    expect(r.commit).toBe("abc1234");
    expect(seen).toBe("http://127.0.0.1:7420/git/diff?scope=commit&commit=abc1234&path=a+b.ts&context=20");
    expect(auth).toBe("Bearer tok");
  });

  it("says when the runner has no git API, and passes on its errors", async () => {
    const notFound = async () => new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
    await expect(fetchGitDiff(connection, { scope: "branch" }, notFound)).rejects.toBeInstanceOf(ReviewUnavailable);
    const bad = async () => new Response(JSON.stringify({ error: "Not a usable commit" }), { status: 400 });
    await expect(fetchGitDiff(connection, { scope: "commit", commit: "x" }, bad)).rejects.toThrow("Not a usable commit");
  });
});

describe("thread panel width", () => {
  it("stays between its limits and leaves room for the conversation", () => {
    expect(clampPanelWidth(100, 1600)).toBe(THREAD_PANEL.min);
    expect(clampPanelWidth(600, 1600)).toBe(600);
    expect(clampPanelWidth(5000, 1600)).toBe(1600 - 420);
    expect(clampPanelWidth(5000, 3000)).toBe(THREAD_PANEL.max);
    expect(clampPanelWidth(500, 600)).toBe(THREAD_PANEL.min);
  });
});
