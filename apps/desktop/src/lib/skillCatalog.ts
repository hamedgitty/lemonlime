import { invoke } from "@tauri-apps/api/core";
import { splitFrontMatter } from "./markdown.tsx";
import { fetchBytes, fetchText, fetchTree, mapLimit, rawUrl, repoPage, toBase64, type RepoFile, type RepoRef, type RepoTree } from "./github.ts";

/**
 * Skills to browse: Anthropic's public skills repository on GitHub, read without an
 * account. Installing one downloads its folder into your skills, the same place
 * "Add a skill folder" copies to.
 */

export const SKILLS_SOURCE: RepoRef & { dir: string; label: string } = {
  owner: "anthropics",
  repo: "skills",
  ref: "main",
  dir: "skills",
  label: "Anthropic's skills on GitHub",
};

export const skillsSourcePage = (name?: string) => repoPage(SKILLS_SOURCE, name ? `${SKILLS_SOURCE.dir}/${name}` : undefined);

export interface CatalogSkill {
  name: string;
  /** Its folder in the repository, e.g. "skills/pdf". */
  dir: string;
  /** Paths relative to the skill's folder. */
  files: RepoFile[];
  /** Bytes, all files together. */
  size: number;
  description: string;
  license: string | null;
}

/** Skills (folders holding a SKILL.md) one level under `dir`, from a repository tree. */
export function skillsFromTree(tree: RepoTree, dir = SKILLS_SOURCE.dir): Omit<CatalogSkill, "description" | "license">[] {
  const prefix = `${dir.replace(/\/+$/, "")}/`;
  const byName = new Map<string, RepoFile[]>();
  for (const f of tree.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const name = rest.slice(0, slash);
    const list = byName.get(name) ?? [];
    list.push({ path: rest.slice(slash + 1), size: f.size });
    byName.set(name, list);
  }
  return [...byName.entries()]
    .filter(([name, files]) => validSkillName(name) && files.some(f => f.path === "SKILL.md"))
    .map(([name, files]) => ({ name, dir: `${prefix}${name}`, files, size: files.reduce((n, f) => n + f.size, 0) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The name rules a skill folder has to follow on this computer. */
export const validSkillName = (name: string) => name.length > 0 && name.length <= 64 && !name.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(name);

/** What SKILL.md says about itself: its description and licence. */
export function describeSkill(skillMd: string): { description: string; license: string | null } {
  const { fields } = splitFrontMatter(skillMd);
  const get = (k: string) => fields.find(([key]) => key.toLowerCase() === k)?.[1]?.trim() || null;
  const description = get("description");
  // Folded YAML (`description: >`) has its text on the lines below, which the simple
  // front-matter reader skips; fall back to the first paragraph of the body.
  const usable = description && !/^[>|][-+]?$/.test(description) ? description : firstParagraph(splitFrontMatter(skillMd).body);
  return { description: usable, license: get("license") };
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (t && !t.startsWith("#") && !t.startsWith("```")) return t.replace(/\s+/g, " ").slice(0, 300);
  }
  return "";
}

/** SKILL.md with its `name:` changed, so a renamed copy reads as its own skill. */
export function renameSkill(skillMd: string, name: string): string {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(skillMd);
  if (!m) return skillMd;
  const front = /^name:.*$/m.test(m[2]!) ? m[2]!.replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n${m[2]}`;
  return `${m[1]}${front}${m[3]}${skillMd.slice(m[0].length)}`;
}

/** A free name for your own copy: "pdf-copy", then "pdf-copy-2" and on. */
export function copyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `${name.slice(0, 55)}-copy`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** "1.1 MB", "56 KB". */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

let listing: Promise<CatalogSkill[]> | null = null;

/** The skills in the public repository with their descriptions. Asked once per session. */
export function browseSkills(force = false): Promise<CatalogSkill[]> {
  if (listing && !force) return listing;
  const p = (async () => {
    const found = skillsFromTree(await fetchTree(SKILLS_SOURCE));
    return mapLimit(found, 6, async s => {
      const md = await fetchText(rawUrl(SKILLS_SOURCE, `${s.dir}/SKILL.md`)).catch(() => "");
      return { ...s, ...describeSkill(md) };
    });
  })();
  listing = p;
  p.catch(() => {
    if (listing === p) listing = null;
  });
  return p;
}

export function readCatalogSkill(skill: CatalogSkill, signal?: AbortSignal): Promise<string> {
  return fetchText(rawUrl(SKILLS_SOURCE, `${skill.dir}/SKILL.md`), signal);
}

/**
 * Download a skill and add it to your skills, as `name` (its own name by default). A
 * renamed copy has its SKILL.md renamed to match. Reports progress as files arrive.
 */
export async function installCatalogSkill(skill: CatalogSkill, name = skill.name, onProgress?: (done: number, total: number) => void): Promise<string> {
  let done = 0;
  const files = await mapLimit(skill.files, 6, async f => {
    let bytes = await fetchBytes(rawUrl(SKILLS_SOURCE, `${skill.dir}/${f.path}`));
    if (f.path === "SKILL.md" && name !== skill.name) bytes = new TextEncoder().encode(renameSkill(new TextDecoder().decode(bytes), name));
    onProgress?.(++done, skill.files.length);
    return { path: f.path, base64: toBase64(bytes) };
  });
  return invoke<string>("add_skill_files", { name, files });
}
