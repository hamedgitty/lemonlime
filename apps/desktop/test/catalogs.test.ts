import { afterEach, describe, expect, it, vi } from "vitest";
import { githubRepoOf, mapLimit, parseTree, rawUrl, toBase64, treeUrl } from "../src/lib/github.ts";
import {
  catalogContentsSummary,
  categoryLabel,
  contentsFromPaths,
  groupByCategory,
  installedFrom,
  mcpServerNames,
  parseMarketplace,
  searchCatalog,
} from "../src/lib/pluginCatalog.ts";
import { copyName, describeSkill, renameSkill, sizeLabel, skillsFromTree, validSkillName } from "../src/lib/skillCatalog.ts";
import type { PluginSummary } from "../src/lib/plugins.ts";

// A marketplace.json in the shape the official directory uses: local folders, whole
// repositories, folders inside other repositories, a GitHub shorthand, a command source,
// and a few entries that don't make sense.
const MARKETPLACE = {
  $schema: "https://example.com/marketplace.schema.json",
  name: "demo-directory",
  owner: { name: "Demo" },
  plugins: [
    {
      name: "review-kit",
      description: "Reviews pull requests with a few focused subagents.",
      author: { name: "Demo", email: "team@example.com" },
      source: "./plugins/review-kit",
      category: "productivity",
      homepage: "https://example.com/review-kit",
    },
    {
      name: "pg-tools",
      displayName: "Postgres Tools",
      description: "Query and explain Postgres databases.",
      author: { name: "Db Corp" },
      category: "database",
      source: { source: "url", url: "https://github.com/dbcorp/pg-tools.git", sha: "0123456789abcdef0123456789abcdef01234567" },
      homepage: "https://github.com/dbcorp/pg-tools",
      keywords: ["sql"],
    },
    {
      name: "cloud-deploy",
      description: "Deploy from the terminal.",
      category: "deployment",
      source: { source: "git-subdir", url: "https://github.com/acme/agent-plugins.git", path: "plugins/deploy", ref: "v1.2.0" },
    },
    { name: "shorthand", description: "From a GitHub shorthand.", source: { source: "github", repo: "someone/shorthand" } },
    {
      name: "ts-lsp",
      description: "TypeScript language server.",
      category: "development",
      source: "./plugins/ts-lsp",
      lspServers: { typescript: { command: "typescript-language-server", args: ["--stdio"] } },
      author: "Solo Dev",
    },
    { name: "runs-a-command", description: "Set up by a program.", category: "development", source: { source: "command", command: "tool plugin path" } },
    { name: "", description: "No name" },
    { name: "review-kit", description: "A duplicate name is skipped." },
    "not an object",
  ],
};

describe("plugin directory", () => {
  const list = parseMarketplace(MARKETPLACE, { owner: "demo", repo: "directory", ref: "main" });

  it("reads each usable entry once", () => {
    expect(list.map(p => p.name)).toEqual(["review-kit", "pg-tools", "cloud-deploy", "shorthand", "ts-lsp", "runs-a-command"]);
    const pg = list.find(p => p.name === "pg-tools")!;
    expect(pg.title).toBe("Postgres Tools");
    expect(pg.author).toBe("Db Corp");
    expect(pg.keywords).toEqual(["sql"]);
    expect(list.find(p => p.name === "ts-lsp")!.author).toBe("Solo Dev");
    expect(list.find(p => p.name === "ts-lsp")!.lspServers).toEqual(["typescript"]);
    expect(list.find(p => p.name === "shorthand")!.category).toBe("other");
  });

  it("knows where each plugin's files are", () => {
    const where = Object.fromEntries(list.map(p => [p.name, p.where]));
    expect(where["review-kit"]).toEqual({ kind: "github", owner: "demo", repo: "directory", ref: "main", path: "plugins/review-kit" });
    expect(where["pg-tools"]).toEqual({ kind: "github", owner: "dbcorp", repo: "pg-tools", ref: "0123456789abcdef0123456789abcdef01234567", path: "" });
    expect(where["cloud-deploy"]).toEqual({ kind: "github", owner: "acme", repo: "agent-plugins", ref: "v1.2.0", path: "plugins/deploy" });
    expect(where["shorthand"]).toEqual({ kind: "github", owner: "someone", repo: "shorthand", ref: null, path: "" });
    expect(where["runs-a-command"]).toEqual({ kind: "elsewhere" });
    expect(list.find(p => p.name === "runs-a-command")!.installable).toBe(false);
    expect(list.filter(p => p.installable)).toHaveLength(5);
  });

  it("refuses something that isn't a marketplace", () => {
    expect(() => parseMarketplace({ name: "x" })).toThrow(/shape/);
  });

  it("groups by category, common ones first and Other last", () => {
    const groups = groupByCategory(list);
    expect(groups.map(g => g.category)).toEqual(["development", "productivity", "database", "deployment", "other"]);
    expect(groups[0]!.plugins.map(p => p.name)).toEqual(["runs-a-command", "ts-lsp"]);
    expect(categoryLabel("database")).toBe("Database");
  });

  it("searches every word across name, description, author and keywords", () => {
    expect(searchCatalog(list, "postgres").map(p => p.name)).toEqual(["pg-tools"]);
    expect(searchCatalog(list, "SQL db").map(p => p.name)).toEqual(["pg-tools"]);
    expect(searchCatalog(list, "", "deployment").map(p => p.name)).toEqual(["cloud-deploy"]);
    expect(searchCatalog(list, "postgres", "deployment")).toEqual([]);
  });

  it("finds the installed copy by name, remembered name or repository", () => {
    const installed = (name: string, source: string) => ({ name, source, sourceKind: "git" }) as PluginSummary;
    const pg = list.find(p => p.name === "pg-tools")!;
    const kit = list.find(p => p.name === "review-kit")!;
    expect(installedFrom(kit, [installed("review-kit", "https://github.com/demo/directory")])?.name).toBe("review-kit");
    expect(installedFrom(kit, [installed("kit", "https://github.com/demo/directory")])).toBeNull();
    expect(installedFrom(kit, [installed("kit", "x")], { "review-kit": "kit" })?.name).toBe("kit");
    expect(installedFrom(pg, [installed("postgres", "https://GitHub.com/dbcorp/pg-tools/")])?.name).toBe("postgres");
  });

  it("reads what a plugin adds from its files", () => {
    const c = contentsFromPaths([
      ".claude-plugin/plugin.json",
      "README.md",
      "commands/review.md",
      "commands/git/commit.md",
      "commands/.hidden/x.md",
      "agents/security.md",
      "agents/nested/not-an-agent.md",
      "skills/triage/SKILL.md",
      "skills/triage/notes.md",
      "hooks/hooks.json",
    ]);
    expect(c).toEqual({ commands: ["git/commit", "review"], agents: ["security"], skills: ["triage"], hooks: true, hasReadme: true });
    expect(contentsFromPaths([])).toEqual({ commands: [], agents: [], skills: [], hooks: false, hasReadme: false });
  });

  it("names MCP servers from .mcp.json either way it's written", () => {
    expect(mcpServerNames({ mcpServers: { github: { type: "http", url: "https://example.com/mcp" } } })).toEqual(["github"]);
    expect(mcpServerNames({ context: { command: "npx", args: ["ctx"] }, note: "text" })).toEqual(["context"]);
    expect(mcpServerNames({ name: "plugin", mcpServers: "./.mcp.json" })).toEqual([]);
    expect(mcpServerNames(null)).toEqual([]);
    expect(mcpServerNames([1])).toEqual([]);
  });

  it("sums up what it adds", () => {
    const base = { skills: [], commands: ["a", "b"], agents: [], hooks: false, mcpServers: ["m"], lspServers: [], hasReadme: false, partial: false };
    expect(catalogContentsSummary(base)).toBe("2 commands and 1 MCP server");
    expect(catalogContentsSummary({ ...base, commands: [], mcpServers: [], hooks: true })).toBe("hooks");
    expect(catalogContentsSummary({ ...base, commands: [], mcpServers: [] })).toBe("Nothing listed");
  });
});

// A git tree API response in GitHub's shape, trimmed.
const TREE = {
  sha: "abc",
  url: "https://api.github.com/repos/demo/skills/git/trees/abc",
  truncated: false,
  tree: [
    { path: "README.md", mode: "100644", type: "blob", size: 900 },
    { path: "skills", mode: "040000", type: "tree" },
    { path: "skills/pdf", mode: "040000", type: "tree" },
    { path: "skills/pdf/SKILL.md", mode: "100644", type: "blob", size: 4000 },
    { path: "skills/pdf/scripts/fill.py", mode: "100644", type: "blob", size: 2000 },
    { path: "skills/pdf/LICENSE.txt", mode: "100644", type: "blob", size: 1000 },
    { path: "skills/art/SKILL.md", mode: "100644", type: "blob", size: 500 },
    { path: "skills/notes/README.md", mode: "100644", type: "blob", size: 10 },
    { path: "skills/.hidden/SKILL.md", mode: "100644", type: "blob", size: 10 },
    { path: "skills/loose.md", mode: "100644", type: "blob", size: 10 },
    { path: "template/SKILL.md", mode: "100644", type: "blob", size: 10 },
  ],
};

describe("skills to browse", () => {
  it("finds each folder with a SKILL.md and its files", () => {
    const found = skillsFromTree(parseTree(TREE));
    expect(found.map(s => s.name)).toEqual(["art", "pdf"]);
    const pdf = found[1]!;
    expect(pdf.dir).toBe("skills/pdf");
    expect(pdf.files.map(f => f.path).sort()).toEqual(["LICENSE.txt", "SKILL.md", "scripts/fill.py"]);
    expect(pdf.size).toBe(7000);
  });

  it("refuses a response that isn't a tree", () => {
    expect(() => parseTree({ message: "API rate limit exceeded" })).toThrow();
  });

  it("reads the description and licence from SKILL.md", () => {
    expect(describeSkill("---\nname: pdf\ndescription: Work with PDF files.\nlicense: Complete terms in LICENSE.txt\n---\n\n# PDF\n")).toEqual({
      description: "Work with PDF files.",
      license: "Complete terms in LICENSE.txt",
    });
    // Folded YAML falls back to the first paragraph of the body.
    expect(describeSkill("---\nname: x\ndescription: >\n  long text\n---\n# Title\n\nDoes the thing\nwell.\n").description).toBe("Does the thing well.");
    expect(describeSkill("No front matter at all.")).toEqual({ description: "No front matter at all.", license: null });
  });

  it("renames a copy in its front matter", () => {
    expect(renameSkill("---\nname: pdf\ndescription: d\n---\nBody", "pdf-copy")).toBe("---\nname: pdf-copy\ndescription: d\n---\nBody");
    expect(renameSkill("---\ndescription: d\n---\nBody", "mine")).toBe("---\nname: mine\ndescription: d\n---\nBody");
    expect(renameSkill("Body only", "mine")).toBe("Body only");
  });

  it("picks a free name for your own copy", () => {
    expect(copyName("pdf", [])).toBe("pdf-copy");
    expect(copyName("pdf", ["pdf-copy", "pdf-copy-2"])).toBe("pdf-copy-3");
    expect(validSkillName(copyName("x".repeat(64), []))).toBe(true);
    expect(validSkillName("../up")).toBe(false);
  });

  it("says sizes plainly", () => {
    expect(sizeLabel(56_000)).toBe("55 KB");
    expect(sizeLabel(10)).toBe("1 KB");
    expect(sizeLabel(5_554_003)).toBe("5.3 MB");
  });
});

describe("GitHub helpers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds links that stay inside the repository", () => {
    expect(treeUrl({ owner: "a", repo: "b" })).toBe("https://api.github.com/repos/a/b/git/trees/HEAD?recursive=1");
    expect(rawUrl({ owner: "a", repo: "b", ref: "main" }, "skills/my skill/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/a/b/main/skills/my%20skill/SKILL.md",
    );
  });

  it("reads owner and repository from a link", () => {
    expect(githubRepoOf("https://github.com/dbcorp/pg-tools.git")).toEqual({ owner: "dbcorp", repo: "pg-tools" });
    expect(githubRepoOf("https://github.com/dbcorp/pg-tools/")).toEqual({ owner: "dbcorp", repo: "pg-tools" });
    expect(githubRepoOf("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepoOf("https://github.com/a/b/tree/main")).toBeNull();
  });

  it("encodes bytes as base64", () => {
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(toBase64(new Uint8Array([0, 1, 2, 255]))).toBe("AAEC/w==");
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(big)).length).toBe(100_000);
  });

  it("runs a few at a time and keeps the order", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async n => {
      running++;
      most = Math.max(most, running);
      await new Promise(r => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(most).toBe(2);
  });
});
