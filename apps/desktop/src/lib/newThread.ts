import type { AgentKind, PermissionMode, PolicyDenied, ReasoningLevel, SandboxSize } from "@lemonlime/protocol";

/** What both kinds of new thread may take along with the first message. */
interface FirstMessageExtras {
  /** Files to send with the first message, uploaded once the thread's runner is up. */
  attachments?: File[] | undefined;
  /** The permission mode to start in, when it isn't the usual one for where it runs. */
  permission?: PermissionMode | undefined;
}

export interface NewLocalThread extends FirstMessageExtras {
  mode: "local";
  title: string;
  agent: AgentKind;
  agentCommand: string[] | undefined;
  model: string | undefined;
  reasoning: ReasoningLevel | undefined;
  /** Start in the agent's fast mode. */
  fast?: boolean | undefined;
  repoPath: string;
  /** Run it on one of the user's machines (Settings → Machines) over SSH; repoPath is a path there. */
  machine?: string | undefined;
  baseBranch: string;
  prompt: string | undefined;
  /** Work on this existing branch (maybe a pull request's) instead of making a new one. */
  existingBranch?: { name: string; pullRequest?: { number: number; url: string; title: string } | undefined } | undefined;
  /** Start the new branch from this commit or branch instead of the base (a fork keeps its code). */
  startFrom?: string | undefined;
}

export interface NewCloudThread extends FirstMessageExtras {
  mode: "cloud";
  title: string;
  agent: AgentKind;
  agentCommand: string[] | undefined;
  model: string | undefined;
  reasoning: ReasoningLevel | undefined;
  fast?: boolean | undefined;
  repoUrl: string;
  baseBranch: string;
  sandboxSize: SandboxSize;
  prompt: string | undefined;
}

export type NewThreadInput = NewLocalThread | NewCloudThread;

/** Thrown by `onCreate` to show a policy denial instead of a plain error. */
export class DeniedError extends Error {
  constructor(readonly denial: PolicyDenied) {
    super(denial.reason);
  }
}
