import type { ThreadSummary } from "./threads.ts";
import { AGENT_LABELS, STATUS_LABELS, relativeTime, repoName } from "./format.ts";
import { snoozeWhen } from "./threadMenu.ts";

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

/**
 * The hover card on a sidebar row, line by line: its project, branch, agent and model,
 * where it runs, its pull request (when one is known), and when it last did something.
 */
export function threadCardLines(
  t: Pick<ThreadSummary, "repo" | "branch" | "agent" | "mode" | "machine" | "status" | "updatedAt">,
  o: { machineName?: string | null; pullRequest?: KnownPullRequest | null; snoozedUntil?: string | null; now?: number } = {},
): ThreadCardLine[] {
  const lines: ThreadCardLine[] = [
    { label: "Project", value: repoName(t.repo) },
    { label: "Branch", value: t.branch },
    { label: "Agent", value: t.agent.model ? `${AGENT_LABELS[t.agent.kind]}, ${t.agent.model}` : AGENT_LABELS[t.agent.kind] },
    { label: "Runs", value: t.mode === "cloud" ? "In the cloud" : t.machine ? `On ${o.machineName ?? "a removed machine"}` : "On this computer" },
  ];
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
  lines.push({ label: "Last activity", value: ago ? `${STATUS_LABELS[t.status]}, ${ago}` : STATUS_LABELS[t.status] });
  return lines;
}
