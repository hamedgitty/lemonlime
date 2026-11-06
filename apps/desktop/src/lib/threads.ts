import type { AgentConfig, Thread } from "@lemonlime/protocol";
import type { LocalThreadMeta } from "./storage.ts";
import { repoName, type DisplayStatus } from "./format.ts";

/** A thread as the sidebar sees it: local (this computer) or cloud (control plane). */
export type ThreadEntry = { mode: "local"; meta: LocalThreadMeta } | { mode: "cloud"; thread: Thread };

export interface ThreadSummary {
  id: string;
  mode: "local" | "cloud";
  title: string;
  agent: AgentConfig;
  repo: string;
  branch: string;
  status: DisplayStatus;
  updatedAt: string;
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
      status: runnerUp ? m.status : m.status === "failed" ? "failed" : "offline",
      updatedAt: m.updatedAt,
    };
  }
  const t = entry.thread;
  return {
    id: t.id,
    mode: "cloud",
    title: t.title || repoName(t.repo.url),
    agent: t.agent,
    repo: t.repo.url,
    branch: t.branch,
    status: t.status,
    updatedAt: t.updatedAt,
  };
}

/** Newest activity first. */
export function sortByActivity<T extends { updatedAt: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
