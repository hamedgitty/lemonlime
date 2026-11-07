import type { AgentConfig, RepoRef } from "@lemonlime/protocol";
import type { RunnerLaunch } from "@lemonlime/sandbox";

/** Port the runner listens on inside every sandbox (see docs/runner.md). */
export const RUNNER_PORT = 7420;

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argument for a POSIX shell. Plain words pass through; anything else
 * is wrapped in single quotes, with embedded single quotes written as '\''.
 */
export function shellQuote(arg: string): string {
  if (arg.includes("\0")) throw new Error("shell arguments cannot contain NUL bytes");
  if (arg === "") return "''";
  if (SAFE_ARG.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

export interface RunnerCommandInput {
  threadId: string;
  agent: AgentConfig;
  repo: RepoRef;
  /** Public URL of this control plane, for heartbeats. */
  controlPlaneUrl: string;
  port?: number;
  /** The sandbox can't reach the control plane: the runner keeps its calls for us to collect. */
  relay?: boolean;
}

/** A value that follows a flag must not look like a flag itself. */
function value(flag: string, v: string): string {
  if (v.startsWith("-")) throw new Error(`${flag} value cannot start with "-"`);
  return v;
}

/** argv for the runner, in the order documented in docs/runner.md. */
export function runnerArgs(input: RunnerCommandInput): string[] {
  const { threadId, agent, repo } = input;
  const args = ["lemonlime-runner", "--thread", value("--thread", threadId), "--agent", agent.kind];
  if (agent.kind === "acp") {
    if (!agent.command?.length) throw new Error("ACP agents need a command");
    // The runner takes the ACP command as one string, e.g. "gemini --experimental-acp".
    args.push("--agent-command", value("--agent-command", shellJoin(agent.command)));
  }
  if (agent.model) args.push("--model", value("--model", agent.model));
  if (agent.reasoning) args.push("--reasoning", agent.reasoning);
  args.push(
    "--repo",
    value("--repo", repo.url),
    "--base",
    value("--base", repo.baseBranch),
    "--host",
    "0.0.0.0",
    "--port",
    String(input.port ?? RUNNER_PORT),
    "--control-plane",
    value("--control-plane", input.controlPlaneUrl),
  );
  if (input.relay) args.push("--relay");
  return args;
}

/** The shell command a sandbox runs to start the runner. */
export function buildRunnerCommand(input: RunnerCommandInput): string {
  return shellJoin(runnerArgs(input));
}

/** Everything a SandboxProvider needs to start (or restart) the runner for a thread. */
export function buildRunnerLaunch(
  input: RunnerCommandInput & {
    threadSecret: string;
    secrets?: Record<string, string>;
    /** Relay mode: a first repository token, so the first clone doesn't wait for the relay. */
    gitToken?: { token: string; expiresAt: string; host: string };
  },
): RunnerLaunch {
  const secrets = {
    ...input.secrets,
    ...(input.gitToken
      ? { LEMONLIME_GIT_TOKEN: input.gitToken.token, LEMONLIME_GIT_TOKEN_EXPIRES: input.gitToken.expiresAt, LEMONLIME_GIT_HOST: input.gitToken.host }
      : {}),
  };
  const names = Object.keys(secrets)
    .filter(n => n !== "LEMONLIME_GIT_TOKEN_EXPIRES" && n !== "LEMONLIME_GIT_HOST")
    .sort();
  return {
    command: buildRunnerCommand(input),
    port: input.port ?? RUNNER_PORT,
    env: {
      ...secrets,
      // Which variables hold secrets, so the runner keeps their values out of every event.
      ...(names.length ? { LEMONLIME_REDACT_ENV: names.join(",") } : {}),
      LEMONLIME_THREAD_SECRET: input.threadSecret,
    },
  };
}

const REPO_URL = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@[A-Za-z0-9.-]+:)[^\s]+$/;
const BRANCH = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)(?<!\.)$/;

/**
 * Checks the parts of a cloud thread that end up on the runner's command line.
 * Returns a user-facing error, or null when everything is fine.
 */
export function validateCloudLaunch(agent: AgentConfig, repo: RepoRef): string | null {
  if (!REPO_URL.test(repo.url)) return "Repository must be a git URL (https://, ssh://, git:// or git@host:path).";
  if (!BRANCH.test(repo.baseBranch)) return "Base branch is not a valid branch name.";
  if (agent.kind === "acp" && !agent.command?.length) return 'ACP agents need a command, e.g. ["opencode", "acp"].';
  if (agent.model !== undefined && (agent.model === "" || agent.model.startsWith("-") || /[\0\r\n]/.test(agent.model))) {
    return "Model name is not valid.";
  }
  if (agent.command?.some(part => part.includes("\0") || /[\r\n]/.test(part))) return "Agent command is not valid.";
  if (agent.command?.[0]?.startsWith("-")) return 'Agent command cannot start with "-".';
  return null;
}
