import type { AgentCommand, AgentKind, NewEvent, Question } from "@lemonlime/protocol";
import type { McpServerConfig } from "../agent-plugins.ts";
import type { ApprovalDecision, ApprovalRequest } from "../approvals.ts";

/**
 * How much the agent may do without asking (the permission modes, plus `read`).
 * - full:  anything (use inside isolated sandboxes)
 * - edits: edits files freely, asks before the rest (most importantly, running commands)
 * - ask:   asks before editing files too
 * - plan:  looks around and proposes a plan; changes nothing
 * - read:  looks, never changes anything, and nobody is asked (side chats)
 */
export type Autonomy = "full" | "edits" | "ask" | "plan" | "read";

/** What can change between turns of one agent session (see AgentSession.setOptions). */
export interface SessionChange {
  /** null: the agent's own default. */
  model?: string | null;
  reasoning?: string | null;
  autonomy?: Autonomy;
}

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
  /** MCP servers from the user's agent plugins, by name (Claude Code and Codex use them). */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * The user's own instructions, added to the agent's context: Claude Code's system prompt,
   * Codex's developer instructions, and the first message of each new ACP conversation.
   */
  instructions?: string;
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
  /**
   * Ask the user multiple-choice questions and wait. Resolves to one list of answers per
   * question (picked labels, or typed text), or null if nobody answered or the turn ended.
   */
  askQuestions?(questions: Question[]): Promise<string[][] | null>;
}

export interface AgentSession {
  /** Run one turn to completion (or until the signal aborts). Throws on agent failure. */
  runTurn(ctx: TurnContext): Promise<void>;
  /** State worth persisting so a restarted runner can continue the same agent session. */
  saveState(): Record<string, string>;
  /**
   * Use a different model, reasoning level or autonomy from the next turn, in the same
   * conversation. Sessions without it are started again (from their saved state) instead.
   */
  setOptions?(change: SessionChange): void;
  dispose(): Promise<void>;
  /** Slash commands the agent said it understands, if it says (shown in the composer's `/` menu). */
  commands?(): AgentCommand[];
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
    /** For `usage_limit` and `overloaded`: when to try again (ISO), if the agent said. */
    readonly resetAt?: string,
  ) {
    super(message);
  }
}

/** The provider is busy or briefly down: worth trying again in a little while. */
const OVERLOADED =
  /overloaded|\b529\b|\b50[23]\b|service unavailable|bad gateway|server_is_overloaded|high demand|temporarily unavailable|capacity constraints|internal server error/i;

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

/** "retry after 30 seconds", "Retry-After: 30", "try again in 20s": when to try again (ISO), or null. */
export function retryAfterAt(reason: string, now = new Date()): string | null {
  const m = /\b(?:retry[- ]after|try again in|retry in)[:\s]+(\d+)(?!\d)\s*(s\b|secs?\b|seconds?\b)?(?!\s*(?:m|h))/i.exec(reason);
  if (!m) return null;
  return new Date(now.getTime() + Number(m[1]) * 1000).toISOString();
}

/**
 * Pick an error code from the reason an agent gave for failing, so apps can show the
 * right fix: `auth_required` (sign the CLI in again), `agent_outdated` (update the CLI),
 * `usage_limit` (the plan's limit was hit), `overloaded` (the provider is busy; try again
 * later), otherwise `agent_failed`.
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
  if (OVERLOADED.test(reason)) return "overloaded";
  return "agent_failed";
}

/** The error to throw when a turn fails: the agent's own reason if it gave one, else what the process reported. */
export function turnFailure(reason: string | null, processError?: unknown, known?: { resetAt?: string | null }): Error | null {
  if (reason) {
    const code = known?.resetAt ? "usage_limit" : classifyAgentFailure(reason);
    const resetAt =
      code === "usage_limit" ? (known?.resetAt ?? limitResetAt(reason)) : code === "overloaded" ? (retryAfterAt(reason) ?? limitResetAt(reason)) : null;
    return new AgentError(reason, code, resetAt ?? undefined);
  }
  return processError instanceof Error ? processError : processError === undefined ? null : new AgentError(String(processError));
}

/** Apply a change to a session's options in place. */
export function applyChange(opts: SessionOptions, change: SessionChange): void {
  if (change.model !== undefined) {
    if (change.model === null) delete opts.model;
    else opts.model = change.model;
  }
  if (change.reasoning !== undefined) {
    if (change.reasoning === null) delete opts.reasoning;
    else opts.reasoning = change.reasoning;
  }
  if (change.autonomy) opts.autonomy = change.autonomy;
}

/** What agents without a plan mode of their own are told in plan mode. */
export const PLAN_INSTRUCTIONS =
  "You are in plan mode: don't change any files and don't run anything that changes something. Look around as much as you need, then reply with your plan as Markdown: the steps you'd take and the files you'd change. The user reads it and tells you when to go ahead.";

/**
 * In plan mode the agent's last message is its plan. Passes events through, holding back
 * each whole agent message until something follows it; at the end of a turn that finished,
 * the one still held becomes a `plan_proposal`.
 */
export class PlanHold {
  private held: NewEvent | null = null;
  constructor(private readonly emit: (e: NewEvent) => void) {}

  push(e: NewEvent): void {
    if (e.type === "agent_message" && e.partial) return; // plans arrive whole
    if (this.held) this.emit(this.held);
    this.held = null;
    if (e.type === "agent_message") this.held = e;
    else this.emit(e);
  }

  /** `finished`: the turn ended normally, so the held message is the plan. */
  end(finished: boolean): void {
    const held = this.held;
    this.held = null;
    if (!held || held.type !== "agent_message") return;
    if (finished && held.text.trim()) this.emit({ type: "plan_proposal", plan: held.text.trim() });
    else this.emit(held);
  }
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
