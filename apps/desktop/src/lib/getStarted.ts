/**
 * The "Get started" checklist on Home: a few first steps, each ticked from what's really
 * true (not from clicks), shown to new users until done or put away.
 */

export type GetStartedStep = "agent" | "project" | "thread" | "cloud" | "github";

export interface GetStartedFacts {
  /** An agent CLI on this computer is installed and signed in. */
  agentReady: boolean;
  projects: number;
  threads: number;
  cloudThreads: number;
  /** Signed in to a LemonLime control plane. */
  cloudConnected: boolean;
  /** GitHub accounts linked to the workspace; null when unknown or the server has no GitHub App. */
  githubLinked: number | null;
  dismissed: boolean;
}

export interface GetStartedItem {
  id: GetStartedStep;
  label: string;
  done: boolean;
}

/** Beyond this many threads someone isn't new, and the checklist doesn't appear. */
export const NEW_USER_THREADS = 10;

export function getStartedItems(f: GetStartedFacts): GetStartedItem[] {
  const items: GetStartedItem[] = [
    { id: "agent", label: "Connect an agent", done: f.agentReady },
    { id: "project", label: "Open a project", done: f.projects > 0 },
    { id: "thread", label: "Run your first thread", done: f.threads > 0 },
    { id: "cloud", label: "Try a cloud thread", done: f.cloudThreads > 0 },
  ];
  // Only offered where it can be done: a server with a GitHub App (or not signed in yet).
  if (!f.cloudConnected || f.githubLinked !== null) items.push({ id: "github", label: "Connect GitHub", done: (f.githubLinked ?? 0) > 0 });
  return items;
}

/** Whether to show the checklist: not put away, not everything done, and still new. */
export function showGetStarted(f: GetStartedFacts): boolean {
  if (f.dismissed || f.threads >= NEW_USER_THREADS) return false;
  return getStartedItems(f).some(i => !i.done);
}
