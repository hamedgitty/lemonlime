import { describe, expect, it } from "vitest";
import { parseBlocks, tableCsv, tableMarkdown } from "../src/lib/markdown.tsx";
import { fileRef } from "../src/lib/filePaths.ts";

describe("markdown blocks", () => {
  it("nests lists under their items", () => {
    expect(parseBlocks("- one\n  - inner\n  - more\n- two")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          {
            task: null,
            blocks: [
              { kind: "para", text: "one" },
              {
                kind: "list",
                ordered: false,
                start: 1,
                items: [
                  { task: null, blocks: [{ kind: "para", text: "inner" }] },
                  { task: null, blocks: [{ kind: "para", text: "more" }] },
                ],
              },
            ],
          },
          { task: null, blocks: [{ kind: "para", text: "two" }] },
        ],
      },
    ]);
  });

  it("keeps an ordered list's start and its code under an item", () => {
    const [list] = parseBlocks("3. run it:\n\n   ```sh\n   pnpm test\n   ```\n4. done");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });
    const items = (list as Extract<typeof list, { kind: "list" }>).items;
    expect(items).toHaveLength(2);
    expect(items[0]!.blocks[1]).toEqual({ kind: "code", lang: "sh", text: "pnpm test" });
  });

  it("reads task boxes", () => {
    const [list] = parseBlocks("- [x] done\n- [ ] to do");
    expect((list as Extract<typeof list, { kind: "list" }>).items.map(i => i.task)).toEqual([true, false]);
  });

  it("nests quotes and lists inside quotes", () => {
    expect(parseBlocks("> outer\n>> inner\n> - item")).toEqual([
      {
        kind: "quote",
        blocks: [
          { kind: "para", text: "outer" },
          { kind: "quote", blocks: [{ kind: "para", text: "inner" }] },
          { kind: "list", ordered: false, start: 1, items: [{ task: null, blocks: [{ kind: "para", text: "item" }] }] },
        ],
      },
    ]);
  });

  it("keeps hard line breaks and joins soft ones", () => {
    expect(parseBlocks("one  \ntwo\\\nthree\nfour")).toEqual([{ kind: "para", text: "one\ntwo\nthree four" }]);
  });

  it("copies a table as Markdown or CSV", () => {
    const head = ["Name", "Note"];
    const rows = [
      ["**a**", "x, y"],
      ["b", 'say "hi"'],
    ];
    expect(tableMarkdown(head, rows)).toBe('| Name | Note |\n| --- | --- |\n| **a** | x, y |\n| b | say "hi" |');
    expect(tableCsv(head, rows)).toBe('Name,Note\na,"x, y"\nb,"say ""hi"""');
  });
});

describe("file paths in replies", () => {
  it("spots paths in the project, with a line", () => {
    expect(fileRef("src/app.ts:12")).toEqual({ path: "src/app.ts", line: 12 });
    expect(fileRef("./src/app.ts")).toEqual({ path: "src/app.ts" });
    expect(fileRef("lib/x.py#L40-L52")).toEqual({ path: "lib/x.py", line: 40 });
    expect(fileRef("package.json")).toEqual({ path: "package.json" });
    expect(fileRef(".github/workflows/ci.yml")).toEqual({ path: ".github/workflows/ci.yml" });
    expect(fileRef("docker/Dockerfile")).toEqual({ path: "docker/Dockerfile" });
  });

  it("takes absolute paths only inside the project", () => {
    expect(fileRef("/work/repo/src/a.ts:3", "/work/repo")).toEqual({ path: "src/a.ts", line: 3 });
    expect(fileRef("/etc/hosts.conf", "/work/repo")).toBeNull();
    expect(fileRef("/work/repo/src/a.ts")).toBeNull();
  });

  it("leaves code that isn't a path alone", () => {
    for (const s of ["console.log", "1.2.3", "e.g.", "https://x.dev/a.ts", "../outside.ts", "npm run build", "foo.bar()", "user/repo", "*.ts", "~/notes.md"])
      expect(fileRef(s), s).toBeNull();
  });
});
