import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { fuzzyFilter, type AgentCommand, type AgentCommandSource, type AgentKind, type FilesResponse, type FolderResponse } from "@lemonlime/protocol";
import { listSkills, skillsDirFor } from "./skills.ts";

const run = promisify(execFile);

/**
 * What the app's composer offers as you type: `@` lists files in the thread's working
 * directory, `/` lists the agent's slash commands. See packages/protocol/src/composer.ts.
 */

/** Most files listed from one working directory. */
export const MAX_FILES = 50_000;
/** A listing is reused for this long, so typing doesn't run git on every key. */
const CACHE_MS = 10_000;
/** Folders never walked when the working directory isn't a git repository. */
const SKIP_DIRS = new Set([".git", "node_modules", ".lemonlime", "dist", "build", "target", ".next", ".venv", "__pycache__"]);

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Files in `workdir`: tracked by git plus new ones git doesn't ignore, or a short walk without git. */
export function listWorkdirFiles(workdir: string, now = Date.now()): Promise<string[]> {
  const hit = cache.get(workdir);
  if (hit && now - hit.at < CACHE_MS) return hit.files;
  const files = gitFiles(workdir).catch(() => walk(workdir));
  cache.set(workdir, { at: now, files });
  files.catch(() => cache.delete(workdir));
  return files;
}

async function gitFiles(workdir: string): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: workdir,
    maxBuffer: 64 * 1024 * 1024,
  });
  const seen = new Set<string>();
  for (const f of stdout.split("\0")) {
    if (!f || f.startsWith(".lemonlime/")) continue;
    seen.add(f);
    if (seen.size >= MAX_FILES) break;
  }
  return [...seen];
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.isFile()) out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
    }
  }
  return out;
}

/**
 * The best matches for `query`, at most `limit`. With no query, files near the top of the
 * tree come first.
 */
export function searchFiles(files: readonly string[], query: string, limit: number): FilesResponse {
  const q = query.trim();
  if (!q) {
    const sorted = [...files].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    return { files: sorted.slice(0, limit), total: files.length, truncated: files.length > limit };
  }
  const ranked = fuzzyFilter(files, q, f => f, { paths: true });
  return { files: ranked.slice(0, limit).map(r => r.item), total: files.length, truncated: ranked.length > limit };
}

const depth = (p: string) => p.split("/").length;

/**
 * What one folder holds, from the working directory's file list (so ignored files stay out):
 * its sub-folders, then its files, each by name. `dir` is relative, "" for the top.
 */
export function folderEntries(files: readonly string[], dir: string, limit: number): FolderResponse {
  const prefix = dir.replace(/^\/+|\/+$/g, "");
  const start = prefix ? `${prefix}/` : "";
  const dirs = new Set<string>();
  const names = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(start)) continue;
    const rest = f.slice(start.length);
    const slash = rest.indexOf("/");
    if (slash === -1) names.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const entries = [...[...dirs].sort(byName).map(name => ({ name, dir: true })), ...[...names].sort(byName).map(name => ({ name, dir: false }))];
  return { dir: prefix, entries: entries.slice(0, limit), truncated: entries.length > limit };
}

/**
 * Slash commands for the thread: what the agent reported, then command files and skills it
 * would load from the working directory (and, for Claude Code, the user's own folders).
 * The first one with a name wins.
 */
export function listCommands(opts: { kind: AgentKind; workdir: string; reported: readonly AgentCommand[]; home?: string }): AgentCommand[] {
  const out = new Map<string, AgentCommand>();
  const add = (c: AgentCommand) => {
    const existing = out.get(c.name);
    // The agent's own list has names only; a file's description fills it in.
    if (existing) {
      if (!existing.description && c.description) out.set(c.name, { ...existing, description: c.description });
      return;
    }
    out.set(c.name, c);
  };
  for (const c of opts.reported) add(c);
  if (opts.kind === "claude-code") {
    const home = opts.home ?? homedir();
    for (const c of commandFiles(join(opts.workdir, ".claude", "commands"), "project")) add(c);
    for (const c of skillCommands(join(opts.workdir, skillsDirFor(opts.kind)))) add(c);
    for (const c of commandFiles(join(home, ".claude", "commands"), "user")) add(c);
    for (const c of skillCommands(join(home, ".claude", "skills"))) add(c);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `.claude/commands/review.md` → `review`; `frontend/component.md` → `frontend:component`. */
export function commandFiles(dir: string, source: AgentCommandSource): AgentCommand[] {
  if (!existsSync(dir)) return [];
  const out: AgentCommand[] = [];
  const visit = (d: string, prefix: string[], depthLeft: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depthLeft > 0) visit(full, [...prefix, name], depthLeft - 1);
      } else if (name.endsWith(".md")) {
        const front = readFront(full);
        out.push({
          name: [...prefix, name.slice(0, -3)].join(":"),
          description: front.description,
          ...(front.hint ? { hint: front.hint } : {}),
          source,
        });
      }
    }
  };
  visit(dir, [], 2);
  return out;
}

function skillCommands(dir: string): AgentCommand[] {
  return listSkills(dir).map(name => ({ name, description: readFront(join(dir, name, "SKILL.md")).description, source: "skill" as const }));
}

/** `description:` and `argument-hint:` from a markdown file's front matter, or its first line of text. */
export function readFront(file: string): { description: string; hint?: string } {
  let text = "";
  try {
    text = readFileSync(file, "utf8").slice(0, 8192);
  } catch {
    return { description: "" };
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const field = (key: string) => {
    const line = m?.[1]!.split(/\r?\n/).find(l => l.toLowerCase().startsWith(`${key}:`));
    return line
      ?.slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  };
  const hint = field("argument-hint");
  let description = field("description") ?? "";
  if (!description) {
    const body = m ? text.slice(m[0].length) : text;
    description =
      body
        .split(/\r?\n/)
        .map(l => l.replace(/^#+\s*/, "").trim())
        .find(Boolean) ?? "";
  }
  return { description: description.slice(0, 300), ...(hint ? { hint: hint.slice(0, 100) } : {}) };
}

/** Claude Code's init message lists commands by name: `"slash_commands": ["review", "compact"]`. */
export function commandsFromNames(names: unknown, source: AgentCommandSource = "agent"): AgentCommand[] {
  if (!Array.isArray(names)) return [];
  return names
    .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    .map(n => ({ name: n.replace(/^\//, "").slice(0, 200), description: "", source }));
}

/** ACP's `available_commands_update`: `[{ name, description, input: { hint } }]`. */
export function commandsFromAcp(list: unknown): AgentCommand[] {
  if (!Array.isArray(list)) return [];
  const out: AgentCommand[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const { name, description, input } = c as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
    if (typeof name !== "string" || !name.trim()) continue;
    const hint = typeof input?.hint === "string" ? input.hint.slice(0, 200) : undefined;
    out.push({
      name: name.replace(/^\//, "").slice(0, 200),
      description: typeof description === "string" ? description.slice(0, 1000) : "",
      ...(hint ? { hint } : {}),
      source: "agent",
    });
  }
  return out;
}
