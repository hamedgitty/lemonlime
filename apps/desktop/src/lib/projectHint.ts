import { repoName } from "./format.ts";

/**
 * Folder names too common to mean a particular project when they turn up in a sentence
 * ("fix the api", "update the docs").
 */
const COMMON = new Set([
  "api",
  "app",
  "apps",
  "backend",
  "client",
  "code",
  "core",
  "docs",
  "frontend",
  "lib",
  "main",
  "mobile",
  "project",
  "server",
  "site",
  "src",
  "test",
  "tests",
  "tools",
  "ui",
  "web",
  "website",
]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `name` appears in `text` as a whole word (a name's own `-`, `_` and `.` count as part of it). */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w-]|\\.\\w)`, "i").test(text);
}

/**
 * The project a new thread's text clearly names, when it isn't the one chosen: another of
 * the user's projects whose folder name appears as a whole word (and the chosen one's
 * doesn't). Short or everyday names never count. The longest name wins.
 */
export function otherProjectMentioned(text: string, projects: readonly string[], current: string): string | null {
  if (!text.trim()) return null;
  const currentName = current ? repoName(current) : "";
  if (currentName && mentions(text, currentName)) return null;
  let best: { path: string; name: string } | null = null;
  for (const path of projects) {
    if (path === current) continue;
    const name = repoName(path);
    if (name.length < 3 || COMMON.has(name.toLowerCase()) || name.toLowerCase() === currentName.toLowerCase()) continue;
    if (mentions(text, name) && (!best || name.length > best.name.length)) best = { path, name };
  }
  return best?.path ?? null;
}
