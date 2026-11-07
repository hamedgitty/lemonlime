import type { AgentKind, NewEvent } from "@lemonlime/protocol";

/**
 * How much the agent may do without asking.
 * - full:  run any command and edit any file (use inside isolated sandboxes)
 * - edits: edit files freely, but the agent's own safety rules apply to commands
 */
export type Autonomy = "full" | "edits";

export interface SessionOptions {
  cwd: string;
  model?: string;
  /** Command + args, required for ACP agents. */
  command?: string[];
  autonomy: Autonomy;
  env?: Record<string, string>;
  /** Saved adapter state from a previous runner process, e.g. the agent's session id. */
  saved?: Record<string, string>;
}

export interface TurnContext {
  prompt: string;
  signal: AbortSignal;
  emit(event: NewEvent): void;
}

export interface AgentSession {
  /** Run one turn to completion (or until the signal aborts). Throws on agent failure. */
  runTurn(ctx: TurnContext): Promise<void>;
  /** State worth persisting so a restarted runner can continue the same agent session. */
  saveState(): Record<string, string>;
  dispose(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  createSession(opts: SessionOptions): AgentSession;
}

/** Thrown when the agent CLI exits unsuccessfully. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly code = "agent_failed",
  ) {
    super(message);
  }
}

/**
 * Pick an error code from the reason an agent gave for failing, so apps can show the
 * right fix: `auth_required` (sign the CLI in again), `agent_outdated` (update the CLI),
 * otherwise `agent_failed`.
 */
export function classifyAgentFailure(reason: string): string {
  if (/not logged in|log ?in expired|please (run )?\/?login|run \/login|invalid api key|not authenticated|authentication (failed|required)|unauthori[sz]ed|\b401\b/i.test(reason)) {
    return "auth_required";
  }
  if (/requires a newer version|please upgrade|update (the )?(cli|app) and try again/i.test(reason)) return "agent_outdated";
  return "agent_failed";
}

/** The error to throw when a turn fails: the agent's own reason if it gave one, else what the process reported. */
export function turnFailure(reason: string | null, processError?: unknown): Error | null {
  if (reason) return new AgentError(reason, classifyAgentFailure(reason));
  return processError instanceof Error ? processError : processError === undefined ? null : new AgentError(String(processError));
}
