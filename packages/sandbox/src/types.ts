import type { SandboxSize } from "@lemonlime/protocol";

export type SandboxState = "starting" | "running" | "paused" | "stopped" | "error" | "unknown";

/** How to start the runner inside a sandbox. Used on create and again after a cold resume. */
export interface RunnerLaunch {
  /** Shell command that starts the runner, e.g. `lemonlime-runner --thread abc ...`. */
  command: string;
  /** Port the runner listens on inside the sandbox. */
  port: number;
  /** Environment for the runner (token secret, control plane URL, ...). */
  env: Record<string, string>;
}

export interface CreateSandboxOptions {
  threadId: string;
  size: SandboxSize;
  runner: RunnerLaunch;
  /** Extra labels/metadata, useful for finding sandboxes later. */
  labels?: Record<string, string>;
}

export interface SandboxInfo {
  id: string;
  provider: string;
  state: SandboxState;
  /** Base HTTP(S) URL of the runner, or null when not reachable (e.g. paused). */
  runnerUrl: string | null;
}

/**
 * A place to run one agent in isolation. Implementations must be idempotent where
 * possible: pausing a paused sandbox or destroying a missing one is not an error.
 */
export interface SandboxProvider {
  readonly name: string;
  /** Create a sandbox, start the runner in it and return where to reach it. */
  create(opts: CreateSandboxOptions): Promise<SandboxInfo>;
  /** Current state, or null if the sandbox no longer exists. */
  get(id: string): Promise<SandboxInfo | null>;
  /** Stop compute billing while keeping the sandbox's files. */
  pause(id: string): Promise<void>;
  /** Bring a paused sandbox back and make sure the runner is up. */
  resume(id: string, runner: RunnerLaunch): Promise<SandboxInfo>;
  /** Delete the sandbox and everything in it. */
  destroy(id: string): Promise<void>;
}

/** Turn a runner's HTTP base URL into its WebSocket URL. */
export function runnerWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/?$/, "/ws");
  return u.toString();
}
