import type { ThreadSummary } from "./threads.ts";
import { AGENT_LABELS, relativeTime, repoName } from "./format.ts";
import { snoozeWhen } from "./threadMenu.ts";
import { statusLabel, type Sharing } from "./threadAccess.ts";

/** A pull request as the app last saw it (lib/threadMenu.ts keeps them for this run). */
export interface KnownPullRequest {
  number?: number | undefined;
  state?: "open" | "closed" | "merged" | undefined;
  draft?: boolean | undefined;
}

export interface ThreadCardLine {
  label: string;
  value: string;
}

/** Whose a workspace's cloud thread is, for the threads where that changes what you can do. */
const SHARING_LINES: Record<Sharing, ThreadCardLine> = {
  "read-only": { label: "Started by", value: "Someone else, read only" },
  "shared-with-you": { label: "Started by", value: "Someone else, shared with you" },
  "shared-by-you": { label: "Shared", value: "With this workspace" },
};

/**
 * The hover card on a sidebar row, line by line: its project, branch, agent and model,
 * where it runs, whose it is (when someone else's or shared), its pull request (when one is
 * known), and when it last did something.
 */
export function threadCardLines(
  t: Pick<ThreadSummary, "repo" | "branch" | "agent" | "mode" | "machine" | "sharing" | "status" | "updatedAt">,
  o: { machineName?: string | null; pullRequest?: KnownPullRequest | null; snoozedUntil?: string | null; now?: number } = {},
): ThreadCardLine[] {
  const lines: ThreadCardLine[] = [
    { label: "Project", value: repoName(t.repo) },
    { label: "Branch", value: t.branch },
    { label: "Agent", value: t.agent.model ? `${AGENT_LABELS[t.agent.kind]}, ${t.agent.model}` : AGENT_LABELS[t.agent.kind] },
    { label: "Runs", value: t.mode === "cloud" ? "In the cloud" : t.machine ? `On ${o.machineName ?? "a removed machine"}` : "On this computer" },
  ];
  if (t.sharing) lines.push(SHARING_LINES[t.sharing]);
  const pr = o.pullRequest;
  if (pr) {
    const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : pr.state === "open" ? "open" : "";
    const name = pr.number ? `#${pr.number}` : "Opened";
    lines.push({ label: "Pull request", value: state ? `${name}, ${state}` : name });
  }
  if (o.snoozedUntil) {
    const now = new Date(o.now ?? Date.now());
    lines.push({ label: "Snoozed", value: `Until ${snoozeWhen(new Date(o.snoozedUntil), now)}` });
  }
  const ago = relativeTime(t.updatedAt, o.now);
  const status = statusLabel(t.status, t.sharing);
  lines.push({ label: "Last activity", value: ago ? `${status}, ${ago}` : status });
  return lines;
}
