import type { AgentConfig, Thread } from "@lemonlime/protocol";
import type { LocalThreadMeta } from "./storage.ts";
import { repoName, type DisplayStatus } from "./format.ts";
import { sharingOf, type Sharing } from "./threadAccess.ts";

/** A thread as the sidebar sees it: local (this computer) or cloud (control plane). */
export type ThreadEntry = { mode: "local"; meta: LocalThreadMeta } | { mode: "cloud"; thread: Thread };

export interface ThreadSummary {
  id: string;
  mode: "local" | "cloud";
  title: string;
  agent: AgentConfig;
  repo: string;
  branch: string;
  /** Local threads on another machine (Settings → Machines): its id. */
  machine?: string;
  /** Cloud threads in a workspace: someone else's, or one that is shared. Missing for your own that nobody else can direct. */
  sharing?: Sharing;
  status: DisplayStatus;
  updatedAt: string;
  createdAt: string;
}

export function summarize(entry: ThreadEntry, runnerUp: boolean): ThreadSummary {
  if (entry.mode === "local") {
    const m = entry.meta;
    return {
      id: m.id,
      mode: "local",
      title: m.title || repoName(m.repoPath),
      agent: m.agent,
      repo: m.repoPath,
      branch: m.branch,
      ...(m.machine ? { machine: m.machine } : {}),
      status: runnerUp ? m.status : m.status === "failed" ? "failed" : "offline",
      updatedAt: m.updatedAt,
      createdAt: m.createdAt,
    };
  }
  const t = entry.thread;
  const sharing = sharingOf(t);
  return {
    id: t.id,
    mode: "cloud",
    title: t.title || repoName(t.repo.url),
    agent: t.agent,
    repo: t.repo.url,
    branch: t.branch,
    ...(sharing ? { sharing } : {}),
    status: t.status,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
  };
}

/** Newest activity first. */
export function sortByActivity<T extends { updatedAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
