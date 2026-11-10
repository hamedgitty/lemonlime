import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentKind } from "@lemonlime/protocol";
import { copyFolderInside, placeInside } from "./copy-inside.ts";
import type { GitWorkspace } from "./git.ts";
import { skillsDirFor } from "./skills.ts";

/**
 * Agent plugins: folders that bundle skills, slash commands, subagent definitions, MCP
 * servers and hooks for coding agents, in the widely used layout:
 *
 *   .claude-plugin/plugin.json   name, description, version, author, homepage
 *   skills/<name>/SKILL.md       skills
 *   commands/*.md                slash commands
 *   agents/*.md                  subagent definitions
 *   .mcp.json                    MCP servers
 *   hooks/hooks.json             hooks (listed, never applied; see docs/plugins.md)
 *
 * The desktop app installs them into ~/.lemonlime/plugins/<name>/ and keeps a registry,
 * plugins.json, of where each came from and whether it is turned on. The runner is told
 * that folder with --plugins-dir and puts what each enabled plugin gives into the thread.
 * (Not to be confused with packages/plugins, the hosted-deployment hooks.)
 */

/** Limits a plugin must stay within. It is read on every thread start and partly copied in. */
export interface PluginCaps {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxDepth: number;
}

export const PLUGIN_CAPS: PluginCaps = {
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFiles: 5000,
  maxDepth: 16,
};

/** JSON files (manifest, .mcp.json, hooks.json) and the README are read whole; keep them small. */
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_README_BYTES = 256 * 1024;

/** The registry and the plugin folders live here. */
export const REGISTRY_FILE = "plugins.json";
export const MANIFEST_FILE = join(".claude-plugin", "plugin.json");
export const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

/** Plugins use this in paths to mean "the plugin's own folder". */
const PLUGIN_ROOT_VAR = /\$\{CLAUDE_PLUGIN_ROOT\}/g;

export class PluginError extends Error {}

/** A plugin's name, which is also its folder name: letters, digits, dot, dash, underscore. */
export const PluginName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Plugin names use letters, numbers, dots, dashes and underscores (at most 64).")
  .refine(n => !n.includes(".."), "Plugin names can't contain '..'.");

/** A file name segment for skills, commands and agents. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** True for a relative path that stays inside the folder it is relative to. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 500 || p.includes("\0") || p.includes("\\")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every(s => s !== "..");
}

const RelPath = z.string().refine(isSafeRelativePath, "Paths must be relative and stay inside the plugin.");
const PathList = z.union([RelPath, z.array(RelPath).max(50)]);

export const McpServerName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "MCP server names use letters, numbers, dashes and underscores.");

const StdioServer = z.looseObject({
  type: z.literal("stdio").optional(),
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(4000)).max(200).optional(),
  env: z.record(z.string().max(200), z.string().max(8000)).optional(),
});
const RemoteServer = z.looseObject({
  type: z.enum(["http", "sse"]),
  url: z
    .string()
    .max(2000)
    .regex(/^https?:\/\//, "MCP server URLs start with http:// or https://."),
  headers: z.record(z.string().max(200), z.string().max(8000)).optional(),
});
export const McpServer = z.union([RemoteServer, StdioServer]);
export type McpServerConfig = z.infer<typeof McpServer>;

const McpServers = z.record(McpServerName, McpServer).refine(r => Object.keys(r).length <= 50, "A plugin can bring at most 50 MCP servers.");
/** `.mcp.json`: `{ "mcpServers": { ... } }`, or the servers on their own. */
export const McpFile = z.union([z.looseObject({ mcpServers: McpServers }), McpServers]);

const HookEvents = z.record(z.string().max(100), z.array(z.unknown()).max(100));
/** `hooks/hooks.json`: `{ "description"?, "hooks": { "<Event>": [...] } }`. */
export const HooksFile = z.union([z.looseObject({ description: z.string().max(2000).optional(), hooks: HookEvents }), HookEvents]);

const Author = z.union([
  z.string().max(200),
  z.looseObject({ name: z.string().max(200), email: z.string().max(200).optional(), url: z.string().max(500).optional() }),
]);

export const PluginManifest = z.looseObject({
  name: PluginName,
  description: z.string().max(2000).optional(),
  version: z.string().max(64).optional(),
  author: Author.optional(),
  homepage: z.string().max(500).optional(),
  repository: z.union([z.string().max(500), z.looseObject({ url: z.string().max(500) })]).optional(),
  license: z.string().max(100).optional(),
  keywords: z.array(z.string().max(64)).max(50).optional(),
  /** Extra places for commands, agents and skills, on top of the default folders. */
  commands: PathList.optional(),
  agents: PathList.optional(),
  skills: PathList.optional(),
  hooks: z.union([RelPath, HooksFile]).optional(),
  mcpServers: z.union([RelPath, McpServers]).optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

/** One plugin listed in a marketplace.json. Only relative sources (inside the same repo) are installable. */
export const MarketplaceEntry = z.looseObject({
  name: PluginName,
  source: z.union([z.string().max(500), z.looseObject({ source: z.string().max(100) })]),
  description: z.string().max(2000).optional(),
  version: z.string().max(64).optional(),
  author: Author.optional(),
  homepage: z.string().max(500).optional(),
  strict: z.boolean().optional(),
});

export const MarketplaceManifest = z.looseObject({
  name: z.string().max(100),
  owner: z.unknown().optional(),
  metadata: z.looseObject({ pluginRoot: z.string().max(500).optional() }).optional(),
  plugins: z.array(MarketplaceEntry).max(500),
});
export type MarketplaceManifest = z.infer<typeof MarketplaceManifest>;

/** One entry in plugins.json (written by the desktop app). */
export const PluginRecord = z.looseObject({
  name: PluginName,
  /** An https git URL or a local folder path. */
  source: z.string().max(2000),
  version: z.string().max(64).nullish(),
  enabled: z.boolean(),
  installedAt: z.string().max(64),
  updatedAt: z.string().max(64),
  /** The git commit installed, for git sources. */
  commit: z.string().max(64).nullish(),
  /** The branch or tag asked for, if any. */
  ref: z.string().max(200).nullish(),
  /** The plugin's folder inside the source (marketplace repos). */
  path: z.string().max(500).nullish(),
});
export type PluginRecord = z.infer<typeof PluginRecord>;

export const PluginsRegistry = z.looseObject({ plugins: z.array(PluginRecord).max(500) });
export type PluginsRegistry = z.infer<typeof PluginsRegistry>;

export interface PluginItem {
  /** e.g. "review" or, for a command in a subfolder, "git/commit". */
  name: string;
  /** Absolute path of the file (commands, agents) or folder (skills). */
  path: string;
}

/** Everything a plugin gives, read from its folder. */
export interface PluginContents {
  root: string;
  manifest: PluginManifest;
  skills: PluginItem[];
  commands: PluginItem[];
  agents: PluginItem[];
  mcpServers: Record<string, McpServerConfig>;
  /** Hook events the plugin defines. LemonLime never runs them. */
  hooks: string[];
  readme: string | null;
}

const zodIssues = (err: z.ZodError): string => err.issues.map(i => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");

/** Parse a JSON file against a schema, with errors that name the file. */
function readJson<T>(file: string, schema: z.ZodType<T>, label: string): T {
  const size = lstatSync(file).size;
  if (size > MAX_JSON_BYTES) throw new PluginError(`${label} is over 1 MB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new PluginError(`${label} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new PluginError(`${label} isn't valid: ${zodIssues(parsed.error)}`);
  return parsed.data;
}

/**
 * Walk a plugin folder and refuse anything unsafe to read or copy: links (they could point
 * anywhere), files over the size cap, too many files, too deep. A `.git` folder at the top
 * is skipped (it is never copied anywhere).
 */
export function checkPluginTree(root: string, caps: PluginCaps = PLUGIN_CAPS): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > caps.maxDepth) throw new PluginError(`${relative(root, dir)} is nested too deeply.`);
    for (const name of readdirSync(dir)) {
      if (depth === 0 && name === ".git") continue;
      const full = join(dir, name);
      const st = lstatSync(full);
      const rel = relative(root, full).split(sep).join("/");
      if (st.isSymbolicLink()) throw new PluginError(`${rel} is a link; plugins can't contain links.`);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) {
        if (st.size > caps.maxFileBytes) throw new PluginError(`${rel} is over ${Math.round(caps.maxFileBytes / 1024 / 1024)} MB.`);
        files++;
        bytes += st.size;
        if (files > caps.maxFiles) throw new PluginError(`The plugin has more than ${caps.maxFiles} files.`);
        if (bytes > caps.maxTotalBytes) throw new PluginError(`The plugin is over ${Math.round(caps.maxTotalBytes / 1024 / 1024)} MB.`);
      } else throw new PluginError(`${rel} isn't a regular file or folder.`);
    }
  };
  walk(root, 0);
  return { files, bytes };
}

/** `root/rel`, refusing anything that resolves outside `root`. */
export function resolveInside(root: string, rel: string): string {
  const clean = rel.replace(/^\.\/+/, "");
  if (!isSafeRelativePath(clean)) throw new PluginError(`${rel} points outside the plugin.`);
  const full = resolve(root, clean);
  const back = relative(root, full);
  if (back.startsWith("..") || isAbsolute(back)) throw new PluginError(`${rel} points outside the plugin.`);
  return full;
}

const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Markdown files under `dir` (or `dir` itself if it is one), named by their path without ".md". */
function markdownFiles(dir: string, recursive: boolean): PluginItem[] {
  if (!existsSync(dir)) return [];
  const st = lstatSync(dir);
  if (st.isFile()) {
    const base = dir.split(sep).pop()!;
    return base.endsWith(".md") && SEGMENT.test(base) ? [{ name: base.slice(0, -3), path: dir }] : [];
  }
  const out: PluginItem[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (!SEGMENT.test(name)) continue;
      const s = lstatSync(full);
      if (s.isDirectory() && recursive) walk(full, `${prefix}${name}/`);
      else if (s.isFile() && name.endsWith(".md") && name.length > 3) out.push({ name: `${prefix}${name.slice(0, -3)}`, path: full });
    }
  };
  walk(dir, "");
  return out;
}

/** Skill folders (each holding a SKILL.md) directly inside `dir`. */
function skillFolders(dir: string): PluginItem[] {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [];
  // A path that is itself a skill folder counts too.
  if (existsSync(join(dir, "SKILL.md"))) {
    const name = dir.split(sep).pop()!;
    return SEGMENT.test(name) ? [{ name, path: dir }] : [];
  }
  return readdirSync(dir)
    .sort()
    .filter(n => SEGMENT.test(n) && lstatSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, "SKILL.md")))
    .map(name => ({ name, path: join(dir, name) }));
}

const uniqueBy = (items: PluginItem[]): PluginItem[] => {
  const seen = new Set<string>();
  return items.filter(i => (seen.has(i.name) ? false : (seen.add(i.name), true)));
};

/** Read and validate a plugin folder. Throws PluginError when it isn't a usable plugin. */
export function readPlugin(root: string, caps: PluginCaps = PLUGIN_CAPS): PluginContents {
  root = resolve(root);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new PluginError(`${root} isn't a folder.`);
  checkPluginTree(root, caps);
  const manifestPath = join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new PluginError("There's no .claude-plugin/plugin.json, so this isn't a plugin.");
  const manifest = readJson(manifestPath, PluginManifest, "plugin.json");

  const skills = uniqueBy([join(root, "skills"), ...asList(manifest.skills).map(p => resolveInside(root, p))].flatMap(skillFolders));
  const commands = uniqueBy([join(root, "commands"), ...asList(manifest.commands).map(p => resolveInside(root, p))].flatMap(d => markdownFiles(d, true)));
  const agents = uniqueBy([join(root, "agents"), ...asList(manifest.agents).map(p => resolveInside(root, p))].flatMap(d => markdownFiles(d, true)));

  const mcpServers: Record<string, McpServerConfig> = {};
  const addServers = (file: z.infer<typeof McpFile>) => {
    const servers =
      "mcpServers" in file && typeof file.mcpServers === "object"
        ? (file.mcpServers as Record<string, McpServerConfig>)
        : (file as Record<string, McpServerConfig>);
    Object.assign(mcpServers, servers);
  };
  if (existsSync(join(root, ".mcp.json"))) addServers(readJson(join(root, ".mcp.json"), McpFile, ".mcp.json"));
  if (typeof manifest.mcpServers === "string") addServers(readJson(resolveInside(root, manifest.mcpServers), McpFile, manifest.mcpServers));
  else if (manifest.mcpServers) Object.assign(mcpServers, manifest.mcpServers);

  const hooks = new Set<string>();
  const addHooks = (file: z.infer<typeof HooksFile>) => {
    const events = "hooks" in file && file.hooks && typeof file.hooks === "object" && !Array.isArray(file.hooks) ? file.hooks : file;
    for (const k of Object.keys(events)) if (k !== "description") hooks.add(k);
  };
  if (existsSync(join(root, "hooks", "hooks.json"))) addHooks(readJson(join(root, "hooks", "hooks.json"), HooksFile, "hooks/hooks.json"));
  if (typeof manifest.hooks === "string") addHooks(readJson(resolveInside(root, manifest.hooks), HooksFile, manifest.hooks));
  else if (manifest.hooks) addHooks(manifest.hooks);

  let readme: string | null = null;
  const readmeName = existsSync(root) ? readdirSync(root).find(n => /^readme\.md$/i.test(n)) : undefined;
  if (readmeName) {
    const buf = readFileSync(join(root, readmeName));
    readme = buf.subarray(0, MAX_README_BYTES).toString("utf8");
  }
  return { root, manifest, skills, commands, agents, mcpServers, hooks: [...hooks].sort(), readme };
}

/** Where each plugin in a marketplace lives, or why it can't be installed from here. */
export function marketplacePlugins(root: string, market: MarketplaceManifest): Array<{ name: string; path: string | null; reason?: string }> {
  const base = market.metadata?.pluginRoot ?? "";
  return market.plugins.map(p => {
    if (typeof p.source !== "string") return { name: p.name, path: null, reason: `Its source is ${p.source.source}, not a folder in this repository.` };
    if (/^[a-z][a-z0-9+.-]*:/i.test(p.source) || /^[^/]+@[^/]+:/.test(p.source))
      return { name: p.name, path: null, reason: "Its source is another repository." };
    const rel =
      p.source.startsWith("./") || p.source.startsWith("../") || p.source === "." ? p.source : base ? `${base.replace(/\/+$/, "")}/${p.source}` : p.source;
    try {
      return { name: p.name, path: resolveInside(root, rel) };
    } catch {
      return { name: p.name, path: null, reason: "Its source points outside the repository." };
    }
  });
}

export function readMarketplace(root: string): MarketplaceManifest {
  return readJson(join(root, MARKETPLACE_FILE), MarketplaceManifest, "marketplace.json");
}

export function readRegistry(pluginsDir: string): PluginsRegistry {
  const file = join(pluginsDir, REGISTRY_FILE);
  if (!existsSync(file)) return { plugins: [] };
  return readJson(file, PluginsRegistry, REGISTRY_FILE);
}

/** The enabled plugins in `pluginsDir`, read and checked. A broken plugin is skipped and reported. */
export function loadEnabledPlugins(
  pluginsDir: string,
  caps: PluginCaps = PLUGIN_CAPS,
): { plugins: PluginContents[]; problems: Array<{ name: string; message: string }> } {
  const problems: Array<{ name: string; message: string }> = [];
  let registry: PluginsRegistry;
  try {
    registry = readRegistry(pluginsDir);
  } catch (err) {
    return { plugins: [], problems: [{ name: REGISTRY_FILE, message: err instanceof Error ? err.message : String(err) }] };
  }
  const plugins: PluginContents[] = [];
  for (const record of registry.plugins) {
    if (!record.enabled) continue;
    try {
      const plugin = readPlugin(join(pluginsDir, record.name), caps);
      if (plugin.manifest.name !== record.name) throw new PluginError(`Its plugin.json calls it ${plugin.manifest.name}.`);
      plugins.push(plugin);
    } catch (err) {
      problems.push({ name: record.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { plugins, problems };
}

const RESERVED_SERVERS = new Set(["lemonlime", "lemonlime-subagents", "lemonlime_subagents"]);

/** Replace `${CLAUDE_PLUGIN_ROOT}` with the plugin's folder in every string of an MCP server's config. */
function withPluginRoot(server: McpServerConfig, root: string): McpServerConfig {
  const sub = (s: string) => s.replace(PLUGIN_ROOT_VAR, root);
  const subRecord = (r: Record<string, string> | undefined) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sub(v)])) : undefined);
  if ("url" in server && server.type !== "stdio" && typeof server.url === "string") {
    const remote = server as z.infer<typeof RemoteServer>;
    return { ...remote, url: sub(remote.url), ...(remote.headers ? { headers: subRecord(remote.headers)! } : {}) };
  }
  const stdio = server as z.infer<typeof StdioServer>;
  return {
    ...stdio,
    command: sub(stdio.command),
    ...(stdio.args ? { args: stdio.args.map(sub) } : {}),
    env: { CLAUDE_PLUGIN_ROOT: root, ...subRecord(stdio.env) },
  };
}

/**
 * Every enabled plugin's MCP servers under names that don't clash with LemonLime's own or
 * each other's: the server's own name, or `<plugin>-<server>` when that is taken.
 */
export function pluginMcpServers(plugins: PluginContents[]): { servers: Record<string, McpServerConfig>; skipped: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  for (const p of plugins) {
    for (const [name, config] of Object.entries(p.mcpServers)) {
      const candidates = [name, `${p.manifest.name}-${name}`.replace(/[^A-Za-z0-9_-]/g, "_")];
      const free = candidates.find(c => !RESERVED_SERVERS.has(c) && !(c in servers));
      if (!free) {
        skipped.push(`${p.manifest.name}/${name}`);
        continue;
      }
      servers[free] = withPluginRoot(config, p.root);
    }
  }
  return { servers, skipped };
}

/** TOML for a string or array value: JSON's escapes are valid TOML basic-string escapes. */
const toml = (v: string | string[]): string => JSON.stringify(v);
const tomlTable = (r: Record<string, string>): string =>
  `{ ${Object.entries(r)
    .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join(", ")} }`;

/**
 * `-c mcp_servers.<name>...` overrides that give Codex the plugins' MCP servers. Codex has no
 * SSE transport, so SSE servers are left out.
 */
export function codexMcpFlags(servers: Record<string, McpServerConfig>): string[] {
  const flags: string[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const key = `mcp_servers.${name}`;
    if (s.type === "sse") continue;
    if (s.type === "http") {
      const remote = s as z.infer<typeof RemoteServer>;
      flags.push("-c", `${key}.url=${toml(remote.url)}`);
      if (remote.headers && Object.keys(remote.headers).length) flags.push("-c", `${key}.http_headers=${tomlTable(remote.headers)}`);
      continue;
    }
    const stdio = s as z.infer<typeof StdioServer>;
    flags.push("-c", `${key}.command=${toml(stdio.command)}`);
    if (stdio.args?.length) flags.push("-c", `${key}.args=${toml(stdio.args)}`);
    if (stdio.env && Object.keys(stdio.env).length) flags.push("-c", `${key}.env=${tomlTable(stdio.env)}`);
  }
  return flags;
}

/** Which parts of a plugin each agent can use. Hooks are never applied (see docs/plugins.md). */
export function pluginSupport(kind: AgentKind): { skills: boolean; commands: boolean; agents: boolean; mcpServers: boolean } {
  return {
    skills: true,
    commands: kind === "claude-code",
    agents: kind === "claude-code",
    mcpServers: kind === "claude-code" || kind === "codex",
  };
}

/**
 * Copy a Markdown file to `rel` in the working directory, pointing `${CLAUDE_PLUGIN_ROOT}`
 * at the plugin's folder. Returns false, writing nothing, when `rel` leads outside the
 * working directory.
 */
function copyMarkdown(from: string, workdir: string, rel: string, root: string): boolean {
  const to = placeInside(workdir, rel);
  if (!to) return false;
  // A link left where the file goes is removed, never written through.
  rmSync(to, { recursive: true, force: true });
  writeFileSync(to, readFileSync(from, "utf8").replace(PLUGIN_ROOT_VAR, root));
  return true;
}

/** Remove `rel` from the working directory, unless getting there leads outside it. */
function removeInside(workdir: string, rel: string): boolean {
  const at = placeInside(workdir, rel, false);
  if (at) rmSync(at, { recursive: true, force: true });
  return at !== null;
}

export interface PluginInstallResult {
  /** Paths (relative to the workdir) this put in place, for removing them next time. */
  paths: string[];
  skills: string[];
  commands: string[];
  agents: string[];
  mcpServers: Record<string, McpServerConfig>;
  warnings: string[];
}

/** A path from an earlier install that is safe to remove again: one of ours, inside the workdir. */
const OUR_PREFIXES = [".claude/skills/", ".agents/skills/", ".claude/commands/", ".claude/agents/"];
const ownedPath = (p: string) => isSafeRelativePath(p) && OUR_PREFIXES.some(prefix => p.startsWith(prefix) && p.length > prefix.length);

/**
 * Put the enabled plugins into a thread's working directory where its agent finds them:
 * skills for every agent; for Claude Code also commands (`.claude/commands/<plugin>/`) and
 * subagents (`.claude/agents/<plugin>-<name>.md`). MCP servers are returned for the agent
 * session to pass on. Everything copied is kept out of git. Paths a previous install put
 * here (`previous`) that this one doesn't are removed, so a plugin turned off disappears.
 */
export async function installPluginsIntoThread(opts: {
  workdir: string;
  kind: AgentKind;
  git: GitWorkspace | null;
  plugins: PluginContents[];
  /** Skill names already in the thread (bundled and the user's), which plugins don't replace. */
  takenSkills?: Iterable<string>;
  previous?: string[];
}): Promise<PluginInstallResult> {
  const support = pluginSupport(opts.kind);
  const taken = new Set(opts.takenSkills ?? []);
  const result: PluginInstallResult = { paths: [], skills: [], commands: [], agents: [], mcpServers: {}, warnings: [] };
  const skillsDir = skillsDirFor(opts.kind);
  const place = async (rel: string, exclude: string) => {
    result.paths.push(rel);
    await opts.git?.excludePath(exclude);
  };

  for (const plugin of opts.plugins) {
    const name = plugin.manifest.name;
    const outside = (what: string, rel: string) => `${name}: ${what} was left out because ${rel} leads outside the thread's folder.`;
    for (const skill of plugin.skills) {
      if (taken.has(skill.name)) {
        result.warnings.push(`${name}: the skill ${skill.name} was left out because the thread already has one with that name.`);
        continue;
      }
      taken.add(skill.name);
      const rel = `${skillsDir}/${skill.name}`;
      removeInside(opts.workdir, rel);
      if (!copyFolderInside(skill.path, opts.workdir, rel)) {
        result.warnings.push(outside(`the skill ${skill.name}`, rel));
        continue;
      }
      await place(rel, `${rel}/`);
      result.skills.push(`${name}:${skill.name}`);
    }
    if (support.commands && plugin.commands.length) {
      const dir = `.claude/commands/${name}`;
      removeInside(opts.workdir, dir);
      const copied = plugin.commands.filter(c => copyMarkdown(c.path, opts.workdir, `${dir}/${c.name}.md`, plugin.root));
      if (copied.length < plugin.commands.length) result.warnings.push(outside("some of its commands", dir));
      if (copied.length) await place(dir, `${dir}/`);
      result.commands.push(...copied.map(c => `${name}:${c.name}`));
    }
    if (support.agents) {
      for (const a of plugin.agents) {
        const rel = `.claude/agents/${name}-${a.name.replace(/\//g, "-")}.md`;
        if (!copyMarkdown(a.path, opts.workdir, rel, plugin.root)) {
          result.warnings.push(outside(`the agent ${a.name}`, rel));
          continue;
        }
        await place(rel, rel);
        result.agents.push(`${name}:${a.name}`);
      }
    }
  }
  if (support.mcpServers) {
    const { servers, skipped } = pluginMcpServers(opts.plugins);
    result.mcpServers = servers;
    for (const s of skipped) result.warnings.push(`The MCP server ${s} was left out because its name is taken.`);
  }

  const now = new Set(result.paths);
  for (const old of opts.previous ?? []) {
    if (!now.has(old) && ownedPath(old)) removeInside(opts.workdir, old);
  }
  return result;
}
