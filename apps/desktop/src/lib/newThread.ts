import type { AgentKind, PolicyDenied, SandboxSize } from "@lemonlime/protocol";

export interface NewLocalThread {
  mode: "local";
  title: string;
  agent: AgentKind;
  agentCommand: string[] | undefined;
  model: string | undefined;
  repoPath: string;
  baseBranch: string;
  prompt: string | undefined;
}

export interface NewCloudThread {
  mode: "cloud";
  title: string;
  agent: AgentKind;
  agentCommand: string[] | undefined;
  model: string | undefined;
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
