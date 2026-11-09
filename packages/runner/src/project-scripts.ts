import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseProjectConfig, PROJECT_FILE, PROJECT_FILE_MAX_BYTES, type ResolvedScript } from "@lemonlime/protocol";

/**
 * The project's scripts, read from `lemonlime.json` at `root` each time they're asked for
 * (so edits show up at once). A missing file is just no scripts; a broken one says why.
 */
export function loadProjectScripts(root: string): { scripts: ResolvedScript[]; error?: string } {
  const file = join(root, PROJECT_FILE);
  let size: number;
  try {
    const info = statSync(file);
    if (!info.isFile()) return { scripts: [] };
    size = info.size;
  } catch {
    return { scripts: [] };
  }
  if (size > PROJECT_FILE_MAX_BYTES) return { scripts: [], error: `${PROJECT_FILE} is too big (over ${PROJECT_FILE_MAX_BYTES / 1024} KB).` };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { scripts: [], error: `Couldn't read ${PROJECT_FILE}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = parseProjectConfig(text);
  return "error" in parsed ? { scripts: [], error: parsed.error } : { scripts: parsed.scripts };
}
