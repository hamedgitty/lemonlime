import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind } from "@lemonlime/protocol";
import { copyFolderInside } from "./copy-inside.ts";
import type { GitWorkspace } from "./git.ts";

/**
 * Skills that ship with LemonLime and are copied into every thread. The desktop app's
 * single-file runner can't find files next to its source, so it is told where they are.
 */
export const BUNDLED_SKILLS_DIR = process.env.LEMONLIME_SKILLS_DIR || fileURLToPath(new URL("../skills", import.meta.url));

/**
 * Where each agent looks for project skills. Claude Code reads `.claude/skills`, Codex
 * reads `.agents/skills`, OpenCode reads both (so it gets one copy, not two).
 */
export function skillsDirFor(kind: AgentKind): string {
  return kind === "claude-code" ? ".claude/skills" : ".agents/skills";
}

/** Skill folders (each holding a SKILL.md) directly inside `dir`. */
export function listSkills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => !name.startsWith(".") && isFolder(join(dir, name)) && existsSync(join(dir, name, "SKILL.md")))
    .sort();
}

/** A folder, or a link to one. A link that leads nowhere is not. */
function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copy the bundled skills, then any extra skill folders, into the thread's working
 * directory where its agent will find them. Copies are kept out of git (via the repo's
 * local exclude file), so they never end up in the agent's commits. Returns the names
 * of the skills installed.
 */
export async function installSkills(opts: {
  workdir: string;
  kind: AgentKind;
  git: GitWorkspace | null;
  extraDirs?: string[];
  bundled?: boolean;
  /** Bundled skills to leave out, by folder name. */
  disabled?: readonly string[];
  /** Where the bundled skills are (tests). */
  bundledDir?: string;
}): Promise<string[]> {
  const target = skillsDirFor(opts.kind);
  const bundledDir = opts.bundledDir ?? BUNDLED_SKILLS_DIR;
  const sources = [...(opts.bundled === false ? [] : [bundledDir]), ...(opts.extraDirs ?? [])];
  const disabled = new Set(opts.disabled ?? []);
  const installed: string[] = [];
  for (const source of sources) {
    for (const name of listSkills(source)) {
      if (source === bundledDir && disabled.has(name)) continue;
      if (!copyFolderInside(join(source, name), opts.workdir, `${target}/${name}`)) {
        process.stderr.write(`lemonlime-runner: left out the skill ${name}: ${target}/${name} leads outside the thread's folder\n`);
        continue;
      }
      await opts.git?.excludePath(`${target}/${name}/`);
      installed.push(name);
    }
  }
  return installed;
}
