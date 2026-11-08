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
  /**
   * A shell script to run once in a new sandbox before the runner starts (installing
   * tools, say). It runs in the sandbox's starting folder, before the repository is
   * cloned, for at most 15 minutes. Its exit code and output are saved for the runner,
   * which shows them in the thread. Never run again in the same sandbox.
   */
  setupScript?: string;
}

/** Longest a setup script may run, in seconds. */
export const SETUP_TIMEOUT_SECONDS = 900;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The shell command a provider runs to start the runner: `runner.command`, after the
 * setup script when there is one. The script's result goes to ~/.lemonlime/setup.log
 * ("exit <code>", then the last 64 KB of output), which also marks it as done, and the
 * runner is told where it is through LEMONLIME_SETUP_LOG.
 */
export function launchCommand(runner: RunnerLaunch): string {
  if (!runner.setupScript?.trim()) return runner.command;
  const script = [
    'd="${HOME:-/tmp}/.lemonlime"',
    'if [ ! -e "$d/setup.log" ]; then',
    '  mkdir -p "$d"',
    `  printf '%s\\n' ${quote(runner.setupScript)} > "$d/setup.sh"`,
    `  if command -v timeout >/dev/null 2>&1; then timeout ${SETUP_TIMEOUT_SECONDS} sh "$d/setup.sh" > "$d/setup.out" 2>&1 < /dev/null; else sh "$d/setup.sh" > "$d/setup.out" 2>&1 < /dev/null; fi`,
    "  code=$?",
    '  { echo "exit $code"; tail -c 65536 "$d/setup.out"; } > "$d/setup.log.tmp"',
    '  mv "$d/setup.log.tmp" "$d/setup.log"',
    '  rm -f "$d/setup.out"',
    "fi",
    'export LEMONLIME_SETUP_LOG="$d/setup.log"',
    `exec ${runner.command}`,
  ].join("\n");
  return `sh -c ${quote(script)}`;
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
