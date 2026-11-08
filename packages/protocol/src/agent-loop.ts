import type { PermissionMode, ThreadOptions } from "./capabilities.ts";
import { withoutRewound, type EventOf, type ThreadEvent, type TodoItem } from "./events.ts";

/**
 * What the apps show around the composer, worked out from a thread's history: the agent's
 * to-do list, a question waiting for an answer, how full the context window is, the
 * latest plan, and the thread's current options.
 */
export interface AgentLoopState {
  /** The latest to-do list, or null when there is none worth showing. */
  todos: TodoItem[] | null;
  /** A question the agent is waiting on. */
  question: EventOf<"question_request"> | null;
  usage: { used: number; window: number } | null;
  /** The latest plan, and whether it still waits for the user's go-ahead. */
  plan: { seq: number; plan: string; open: boolean } | null;
  /** The latest options recorded in the history (the welcome message has the current ones too). */
  options: ThreadOptions | null;
}

export function agentLoopState(all: readonly ThreadEvent[]): AgentLoopState {
  const events = withoutRewound(all);
  let todos: { items: TodoItem[]; seq: number } | null = null;
  let lastUser = 0;
  let usage: AgentLoopState["usage"] = null;
  let plan: { seq: number; plan: string } | null = null;
  let options: ThreadOptions | null = null;
  const questions = new Map<string, EventOf<"question_request">>();
  for (const e of events) {
    switch (e.type) {
      case "user_message":
        lastUser = e.seq;
        break;
      case "todo_snapshot":
        todos = { items: e.items, seq: e.seq };
        break;
      case "context_usage":
        usage = { used: e.used, window: e.window };
        break;
      case "plan_proposal":
        plan = { seq: e.seq, plan: e.plan };
        break;
      case "options_change":
        options = e.options;
        break;
      case "question_request":
        questions.set(e.requestId, e);
        break;
      case "question_result":
        questions.delete(e.requestId);
        break;
    }
  }
  // A finished list stays in view until the user sends their next message.
  const done = todos !== null && todos.items.every(t => t.status === "completed");
  const showTodos = todos !== null && todos.items.length > 0 && !(done && lastUser > todos.seq);
  return {
    todos: showTodos ? todos!.items : null,
    question: [...questions.values()].at(-1) ?? null,
    usage,
    plan: plan ? { ...plan, open: lastUser < plan.seq } : null,
    options,
  };
}

/** The permission mode to return to when a plan is approved. */
export function modeAfterPlan(options: ThreadOptions | null): PermissionMode {
  const to = options?.exitPlanTo;
  return to && to !== "plan" ? to : "edits";
}

/** What the agent is told when the user approves its plan. */
export const IMPLEMENT_PLAN_PROMPT = "The plan is approved. Go ahead and implement it.";

/** Share of the context window used, 0 to 100 (rounded down), or null if unknown. */
export function contextPercent(usage: { used: number; window: number } | null): number | null {
  if (!usage || usage.window <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((usage.used / usage.window) * 100)));
}
