import type { AgentKind, NewEvent } from "@lemonlime/protocol";
import type { ApprovalDecision, ApprovalRequest } from "../approvals.ts";

/**
 * How much the agent may do without asking.
 * - full:  run any command and edit any file (use inside isolated sandboxes)
 * - edits: edit files freely, but the agent's own safety rules apply to commands
 */
/** `full`: anything. `edits`: edits files, asks before the rest. `read`: looks, never changes anything (side chats). */
export type Autonomy = "full" | "edits" | "read";

export interface SessionOptions {
  cwd: string;
  model?: string;
  /** Command + args, required for ACP agents. */
  command?: string[];
  autonomy: Autonomy;
  env?: Record<string, string>;
  /** Saved adapter state from a previous runner process, e.g. the agent's session id. */
  saved?: Record<string, string>;
  /** Block computer-wrecking commands (see command-guard.ts). On unless set to false. */
  commandGuard?: boolean;
  /** How hard the agent thinks (AGENT_CAPABILITIES lists what each accepts). */
  reasoning?: string;
  /** Offer the subagents tools (an MCP server). On unless set to false (side chats). */
  subagents?: boolean;
}

export interface TurnContext {
  prompt: string;
  signal: AbortSignal;
  emit(event: NewEvent): void;
  /**
   * Ask the user whether the agent may use a tool. Resolves "deny" if nobody answers in
   * time or the turn ends first. Without it, anything that needs asking is denied.
   */
  requestApproval?(req: ApprovalRequest): Promise<ApprovalDecision>;
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
    /** For `usage_limit`: when the user's plan allows more (ISO), if the agent said. */
    readonly resetAt?: string,
  ) {
    super(message);
  }
}

const LIMIT = /usage limit|limit reached|hit your (usage )?limit|usage_limit_reached|out of (extra )?usage|rate limit exceeded|quota (exceeded|reached)/i;

/**
 * When a usage limit lifts, from what agents print: Claude's `…|1731000000`, "resets 3pm",
 * "resets at 3:30 PM", "try again at 15:00", or "try again in 2 hours 5 minutes". Null if
 * it doesn't say. Clock times are taken as local and as the next time that comes round.
 */
export function limitResetAt(reason: string, now = new Date()): string | null {
  const epoch = /\|(\d{10})\b/.exec(reason);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const rel = /\bin\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(reason);
  if (rel && (rel[1] || rel[2])) return new Date(now.getTime() + (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 60_000).toISOString();
  const clock = /\b(?:resets?|try again)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(reason);
  if (clock) {
    let h = Number(clock[1]);
    const m = Number(clock[2] ?? 0);
    const ap = clock[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  return null;
}

/**
 * Pick an error code from the reason an agent gave for failing, so apps can show the
 * right fix: `auth_required` (sign the CLI in again), `agent_outdated` (update the CLI),
 * otherwise `agent_failed`.
 */
export function classifyAgentFailure(reason: string): string {
  if (
    /not logged in|log ?in expired|please (run )?\/?login|run \/login|invalid api key|not authenticated|authentication (failed|required)|unauthori[sz]ed|\b401\b/i.test(
      reason,
    )
  ) {
    return "auth_required";
  }
  if (/requires a newer version|please upgrade|update (the )?(cli|app) and try again/i.test(reason)) return "agent_outdated";
  if (LIMIT.test(reason)) return "usage_limit";
  return "agent_failed";
}

/** The error to throw when a turn fails: the agent's own reason if it gave one, else what the process reported. */
export function turnFailure(reason: string | null, processError?: unknown, known?: { resetAt?: string | null }): Error | null {
  if (reason) {
    const code = known?.resetAt ? "usage_limit" : classifyAgentFailure(reason);
    return new AgentError(reason, code, code === "usage_limit" ? (known?.resetAt ?? limitResetAt(reason) ?? undefined) : undefined);
  }
  return processError instanceof Error ? processError : processError === undefined ? null : new AgentError(String(processError));
}

/** Notice for an output line the agent printed that was too long to keep. */
export function oversizeNotice(bytes: number): NewEvent {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return {
    type: "notice",
    code: "output_too_large",
    message: `The agent printed one piece of output of ${mb} MB, too large to keep, so it was left out of the history.`,
  };
}
