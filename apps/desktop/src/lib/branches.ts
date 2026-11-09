import { fuzzyFilter, parsePullRequestRef, type BranchInfo } from "@lemonlime/protocol";

/** Choosing where a new thread starts on Home: the branch list, and pull requests mentioned in the message. */

/** Branches matching what's typed, best first; everything (newest first) when nothing is typed. */
export function filterBranches(branches: readonly BranchInfo[], query: string, limit = 60): BranchInfo[] {
  const q = query.trim();
  if (!q) return branches.slice(0, limit);
  return fuzzyFilter(branches, q, b => b.name, { limit, paths: true }).map(r => r.item);
}

/**
 * Why a thread can't work on `name` directly, or null when it can. A branch can be checked
 * out in only one folder, and the thread needs its own.
 */
export function existingBranchProblem(branches: readonly BranchInfo[] | null, name: string, projectPath: string): string | null {
  const n = name.trim();
  if (!n) return "Pick the branch the agent should work on.";
  if (!branches) return null;
  const b = branches.find(x => x.name === n);
  if (!b) return `There's no branch named ${n} here or on origin. To make a new branch, choose "New branch from it" instead.`;
  if (!b.checkedOutAt) return null;
  const inProject = samePath(b.checkedOutAt, projectPath);
  return `${n} is checked out in ${inProject ? "your project folder" : b.checkedOutAt}, and a branch can only be checked out in one place. Switch ${inProject ? "your project folder" : "that folder"} to another branch first, or start a new branch from ${n}.`;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/^\/private(?=\/)/, "");
  return norm(a) === norm(b);
}

/**
 * A pull request the message points at: a GitHub pull request link anywhere in it, or the
 * whole message being `#123`. Returns the text to look up, or null.
 */
export function pullRequestIn(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^#\d+$/.test(t)) return parsePullRequestRef(t) ? t : null;
  for (const m of t.matchAll(/https?:\/\/[^\s<>()"']+\/pull\/\d+[^\s<>()"']*/gi)) {
    const link = m[0].replace(/[.,;:!?]+$/, "");
    if (parsePullRequestRef(link)) return link;
  }
  return null;
}
