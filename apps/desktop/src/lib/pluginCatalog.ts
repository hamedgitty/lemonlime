import { z } from "zod";
import { fetchJson, fetchText, fetchTree, githubRepoOf, rawUrl, type RepoRef } from "./github.ts";
import type { PluginSummary } from "./plugins.ts";

/**
 * The plugin catalogue: Anthropic's official Claude Code plugin marketplace on GitHub, read
 * without an account. Installing goes through the usual install-from-git path, naming the
 * plugin in that marketplace.
 */

export const OFFICIAL_MARKETPLACE = {
  owner: "anthropics",
  repo: "claude-plugins-official",
  ref: "main",
  url: "https://github.com/anthropics/claude-plugins-official",
  label: "Anthropic's official plugin directory",
} as const;

const Author = z.union([z.string(), z.looseObject({ name: z.string().optional() })]);
const Entry = z.looseObject({
  name: z.string().min(1).max(200),
  displayName: z.string().optional(),
  description: z.string().optional(),
  author: Author.optional(),
  category: z.string().optional(),
  source: z.unknown(),
  homepage: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  lspServers: z.record(z.string(), z.unknown()).optional(),
});
const Marketplace = z.looseObject({ plugins: z.array(z.unknown()) });

/** Where a plugin's files live. Only GitHub sources can be looked into before installing. */
export type PluginWhere = { kind: "github"; owner: string; repo: string; ref: string | null; path: string } | { kind: "elsewhere" };

export interface CatalogPlugin {
  name: string;
  /** The name to show (some entries give a nicer one). */
  title: string;
  description: string;
  author: string | null;
  category: string;
  homepage: string | null;
  version: string | null;
  keywords: string[];
  /** Language servers it brings (listed in the catalogue itself). */
  lspServers: string[];
  where: PluginWhere;
  /** False for sources the app can't install (a command run on your computer). */
  installable: boolean;
}

const clean = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");

function whereOf(source: unknown, market: RepoRef): { where: PluginWhere; installable: boolean } {
  if (typeof source === "string") {
    if (!source.includes("://"))
      return { where: { kind: "github", owner: market.owner, repo: market.repo, ref: market.ref ?? null, path: clean(source) }, installable: true };
    const gh = githubRepoOf(source);
    return { where: gh ? { kind: "github", ...gh, ref: null, path: "" } : { kind: "elsewhere" }, installable: /^https:\/\//i.test(source) };
  }
  if (!source || typeof source !== "object") return { where: { kind: "elsewhere" }, installable: false };
  const s = source as Record<string, unknown>;
  const text = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() ? (s[k] as string).trim() : null);
  const kind = text("source");
  const ref = text("sha") ?? text("ref");
  const path = clean(text("path") ?? "");
  if (kind === "github") {
    const [owner, repo] = (text("repo") ?? "").split("/");
    return owner && repo ? { where: { kind: "github", owner, repo, ref, path }, installable: true } : { where: { kind: "elsewhere" }, installable: false };
  }
  if (kind === "url" || kind === "git-subdir") {
    const gh = githubRepoOf(text("url") ?? "");
    return { where: gh ? { kind: "github", ...gh, ref, path } : { kind: "elsewhere" }, installable: Boolean(text("url")) };
  }
  return { where: { kind: "elsewhere" }, installable: false };
}

/** The plugins a marketplace.json lists. Entries that don't make sense are left out. */
export function parseMarketplace(raw: unknown, market: RepoRef = OFFICIAL_MARKETPLACE): CatalogPlugin[] {
  const m = Marketplace.safeParse(raw);
  if (!m.success) throw new Error("The plugin directory isn't in a shape LemonLime understands.");
  const out: CatalogPlugin[] = [];
  const seen = new Set<string>();
  for (const item of m.data.plugins) {
    const r = Entry.safeParse(item);
    if (!r.success || seen.has(r.data.name)) continue;
    const e = r.data;
    seen.add(e.name);
    const author = typeof e.author === "string" ? e.author : (e.author?.name ?? null);
    out.push({
      name: e.name,
      title: e.displayName?.trim() || e.name,
      description: e.description?.trim() ?? "",
      author: author?.trim() || null,
      category: e.category?.trim().toLowerCase() || "other",
      homepage: e.homepage && /^https?:\/\//i.test(e.homepage) ? e.homepage : null,
      version: e.version ?? null,
      keywords: [...(e.keywords ?? []), ...(e.tags ?? [])],
      lspServers: Object.keys(e.lspServers ?? {}),
      ...whereOf(e.source, market),
    });
  }
  return out;
}

const CATEGORY_ORDER = ["development", "productivity", "database", "deployment", "monitoring", "security", "testing", "design", "automation"];

/** "Development", "Other": a category as a heading. */
export const categoryLabel = (c: string) => (c ? c[0]!.toUpperCase() + c.slice(1).replace(/-/g, " ") : "Other");

/** Plugins in category groups: the common ones first, the rest A to Z, Other last. */
export function groupByCategory(list: readonly CatalogPlugin[]): { category: string; plugins: CatalogPlugin[] }[] {
  const groups = new Map<string, CatalogPlugin[]>();
  for (const p of list) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
  const rank = (c: string) => (c === "other" ? 1000 : CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : 100);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, plugins]) => ({ category, plugins: [...plugins].sort((x, y) => x.title.localeCompare(y.title)) }));
}

/** Plugins matching every word of a search, in a category ("all" for any). */
export function searchCatalog(list: readonly CatalogPlugin[], query: string, category = "all"): CatalogPlugin[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter(p => {
    if (category !== "all" && p.category !== category) return false;
    const hay = [p.name, p.title, p.description, p.author ?? "", p.category, ...p.keywords].join(" ").toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

const norm = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

/**
 * The installed plugin that came from this catalogue entry, if there is one. `aliases`
 * maps catalogue names to the names plugins installed under (their plugin.json can differ).
 */
export function installedFrom(p: CatalogPlugin, installed: readonly PluginSummary[], aliases: Readonly<Record<string, string>> = {}): PluginSummary | null {
  const byName = installed.find(i => i.name === p.name) ?? (aliases[p.name] ? installed.find(i => i.name === aliases[p.name]) : undefined);
  if (byName) return byName;
  if (p.where.kind !== "github" || p.where.path) return null;
  const url = norm(`https://github.com/${p.where.owner}/${p.where.repo}`);
  return installed.find(i => i.sourceKind === "git" && norm(i.source) === url) ?? null;
}

// ── What a plugin adds, from its files ──────────────────────

export interface CatalogContents {
  skills: string[];
  commands: string[];
  agents: string[];
  /** It defines hooks (which LemonLime doesn't run). */
  hooks: boolean;
  mcpServers: string[];
  lspServers: string[];
  hasReadme: boolean;
  /** Its repository is too big to list completely, so some may be missing. */
  partial: boolean;
}

/** Commands, subagents and skills from the plugin's file paths (relative to its folder). */
export function contentsFromPaths(paths: readonly string[]): Omit<CatalogContents, "mcpServers" | "lspServers" | "partial"> {
  const md = (p: string, dir: string) => (p.startsWith(`${dir}/`) && p.endsWith(".md") ? p.slice(dir.length + 1, -3) : null);
  const commands: string[] = [];
  const agents: string[] = [];
  const skills: string[] = [];
  for (const p of paths) {
    const c = md(p, "commands");
    if (c && !c.split("/").some(s => s.startsWith("."))) commands.push(c);
    const a = md(p, "agents");
    if (a && !a.includes("/")) agents.push(a);
    const s = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (s) skills.push(s[1]!);
  }
  return {
    commands: commands.sort(),
    agents: agents.sort(),
    skills: skills.sort(),
    hooks: paths.includes("hooks/hooks.json"),
    hasReadme: paths.includes("README.md"),
  };
}

/** MCP server names from a .mcp.json (with or without the `mcpServers` wrapper) or plugin.json. */
export function mcpServerNames(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  const servers = o.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) return Object.keys(servers);
  if ("mcpServers" in o) return [];
  return Object.entries(o)
    .filter(([, v]) => v && typeof v === "object" && ("command" in v || "url" in v || "type" in v))
    .map(([k]) => k);
}

export interface CatalogDetail {
  contents: CatalogContents;
  readme: string | null;
}

const details = new Map<string, Promise<CatalogDetail>>();

/** What a plugin adds and its README, read from GitHub. Asked once per plugin per session. */
export function catalogDetail(p: CatalogPlugin): Promise<CatalogDetail> {
  const where = p.where;
  if (where.kind !== "github") return Promise.reject(new Error("This plugin isn't on GitHub, so its files can't be looked at before installing."));
  const key = `${p.name}@${where.owner}/${where.repo}/${where.ref ?? ""}/${where.path}`;
  let d = details.get(key);
  if (!d) {
    d = (async () => {
      const repo: RepoRef = { owner: where.owner, repo: where.repo, ref: where.ref };
      const tree = await fetchTree(repo);
      const prefix = where.path ? `${where.path}/` : "";
      const paths = tree.files.filter(f => f.path.startsWith(prefix)).map(f => f.path.slice(prefix.length));
      const base = contentsFromPaths(paths);
      const json = (rel: string) => (paths.includes(rel) ? fetchJson(rawUrl(repo, `${prefix}${rel}`)).catch(() => null) : Promise.resolve(null));
      const [mcp, manifest, readme] = await Promise.all([
        json(".mcp.json"),
        json(".claude-plugin/plugin.json"),
        base.hasReadme ? fetchText(rawUrl(repo, `${prefix}README.md`)).catch(() => null) : Promise.resolve(null),
      ]);
      const mcpServers = [...new Set([...mcpServerNames(mcp), ...mcpServerNames(manifest)])].sort();
      return { contents: { ...base, mcpServers, lspServers: p.lspServers, partial: tree.truncated }, readme };
    })();
    details.set(key, d);
    d.catch(() => details.delete(key));
  }
  return d;
}

let catalogue: Promise<CatalogPlugin[]> | null = null;

/** Every plugin in the official directory. Asked once per session. */
export function browsePlugins(force = false): Promise<CatalogPlugin[]> {
  if (catalogue && !force) return catalogue;
  const p = fetchJson(rawUrl(OFFICIAL_MARKETPLACE, ".claude-plugin/marketplace.json")).then(raw => parseMarketplace(raw));
  catalogue = p;
  p.catch(() => {
    if (catalogue === p) catalogue = null;
  });
  return p;
}

/** "3 commands, 1 MCP server": a line for a catalogue row's detail. */
export function catalogContentsSummary(c: CatalogContents): string {
  const parts = (
    [
      [c.skills.length, "skill", "skills"],
      [c.commands.length, "command", "commands"],
      [c.agents.length, "subagent", "subagents"],
      [c.mcpServers.length, "MCP server", "MCP servers"],
      [c.lspServers.length, "language server", "language servers"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (c.hooks) parts.push("hooks");
  if (!parts.length) return "Nothing listed";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const ALIASES_KEY = "lemonlime:plugin-catalog-names";

/** Catalogue names of plugins installed from the directory under another name. */
export function loadInstallAliases(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ALIASES_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export function rememberInstallAlias(catalogName: string, installedName: string): Record<string, string> {
  const next = { ...loadInstallAliases() };
  if (catalogName === installedName) delete next[catalogName];
  else next[catalogName] = installedName;
  try {
    localStorage.setItem(ALIASES_KEY, JSON.stringify(next));
  } catch {
    /* not remembered: the plugin still shows as installed when the names match */
  }
  return next;
}
