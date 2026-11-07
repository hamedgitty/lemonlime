import type { SandboxSize } from "@lemonlime/protocol";

/** Who is asking. */
export interface PolicySubject {
  userId: string;
  workspaceId: string;
}

/** A request to start (or resume) a sandbox for a thread. */
export interface SandboxRequest extends PolicySubject {
  threadId: string;
  size: SandboxSize;
}

/**
 * What the sandbox's runner last reported. Measured inside the sandbox, so code running
 * there could fake it: use it as a hint, together with what the provider reports.
 */
export interface SandboxActivity {
  /** Whether the agent is working on a turn right now. */
  agentWorking: boolean;
  /** CPU in use across the sandbox (cores), or null if not reported yet. */
  cpuCores: number | null;
  /** The program using the most CPU, or null. */
  topProcess: string | null;
  /** When the runner last reported (ISO), or null. */
  reportedAt: string | null;
}

/** A sandbox that is currently running. */
export interface RunningSandbox extends SandboxRequest {
  sandboxId: string;
  /** When this run started (ISO). Resets on every resume. */
  runningSince: string;
  /** Present when the control plane has heard from the runner. */
  activity?: SandboxActivity;
}

/** One finished stretch of running time, from start/resume to pause/stop. */
export interface SandboxRun extends RunningSandbox {
  endedAt: string;
  runtimeSeconds: number;
  /** Why the run ended. */
  endReason: "idle" | "user" | "policy" | "error" | "replaced";
}

export type PolicyDecision =
  | { allow: true }
  | {
      allow: false;
      /** Short, user-facing explanation. */
      reason: string;
      /** Optional link the UI can show, with its label. */
      actionUrl?: string;
      actionLabel?: string;
    };

/**
 * Something the deployment wants people to see about their usage, shown as a banner in
 * the dashboard and the desktop app. `blocked` means cloud threads can't start right now.
 */
export interface UsageNotice {
  level: "info" | "warning" | "blocked";
  message: string;
  actionUrl?: string;
  actionLabel?: string;
}

/**
 * A short standing summary of a workspace's usage, for a card in the apps' sidebars,
 * e.g. title "Cloud hours", detail "143 of 200 left this month", progress 0.72.
 */
export interface UsageSummary {
  title: string;
  detail: string;
  /** Share used or left, 0-1, drawn as a bar; omit for none. */
  progress?: number;
  actionUrl?: string;
  actionLabel?: string;
}

/**
 * Decides whether sandboxes may run, and is told when they start and stop.
 *
 * The control plane calls this for every cloud thread. It must never be bypassed,
 * and public code must not special-case any particular implementation.
 */
export interface UsagePolicy {
  /** Before a sandbox is created or resumed. Deny → the request fails with the reason. */
  canStartSandbox(req: SandboxRequest): Promise<PolicyDecision>;
  /** Periodically for every running sandbox. Deny → the control plane pauses it. */
  canKeepRunning(sandbox: RunningSandbox): Promise<PolicyDecision>;
  /** After a sandbox starts or resumes. */
  onSandboxStarted(sandbox: RunningSandbox): Promise<void>;
  /** After a sandbox pauses, stops or dies, with the runtime of that stretch. */
  onSandboxStopped(run: SandboxRun): Promise<void>;
  /** Optional banner for a workspace (e.g. running low). Null or absent shows nothing. */
  notice?(subject: PolicySubject): Promise<UsageNotice | null>;
  /** Optional sidebar card for a workspace. Null or absent shows nothing. */
  summary?(subject: PolicySubject): Promise<UsageSummary | null>;
}

const ALLOW: PolicyDecision = { allow: true };

/** Default policy: everything is allowed and nothing is recorded. Used when self-hosting. */
export const allowAllPolicy: UsagePolicy = {
  async canStartSandbox() {
    return ALLOW;
  },
  async canKeepRunning() {
    return ALLOW;
  },
  async onSandboxStarted() {},
  async onSandboxStopped() {},
};
