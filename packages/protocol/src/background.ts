import { withoutRewound, type SubagentInfo, type ThreadEvent } from "./events.ts";

/**
 * Work a thread has going on beside its main conversation, worked out from its history:
 * the subagents its agent started (the runner's own, and Claude Code's Task tool), and
 * commands the agent left running in the background.
 */

export type ChildState = "done" | "running" | "waiting" | "failed";

export interface ChildWork {
  id: string;
  /** The task it was given, one line. */
  title: string;
  state: ChildState;
  /** The runner's subagent tools, or the agent's own (Claude Code's Task tool). */
  source: "runner" | "agent";
  /** For runner subagents started by another subagent. */
  parentId: string | null;
  startedAt: string;
}

export interface BackgroundCommand {
  id: string;
  command: string;
  /** What the agent said it's for, when it said. */
  description: string | null;
  startedAt: string;
}

export interface BackgroundWork {
  children: ChildWork[];
  commands: BackgroundCommand[];
}

export interface ChildProgress {
  done: number;
  running: number;
  waiting: number;
  failed: number;
  total: number;
}

/** Claude Code's subagent tool (named Task, later Agent). */
const TASK_TOOLS = new Set(["Task", "Agent"]);
/** Claude Code's tools that stop a background shell. */
const KILL_TOOLS = new Set(["KillShell", "KillBash"]);
/** Claude Code's tools that read a background shell's output (and status). */
const OUTPUT_TOOLS = new Set(["BashOutput", "TaskOutput"]);

const oneLine = (s: string, max = 160) => {
  const line = s.split(/\r?\n/).find(l => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const field = (input: unknown, ...keys: string[]): string | null => {
  if (!input || typeof input !== "object") return null;
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
};

const text = (output: unknown): string => {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return "";
  }
};

const RUNNER_STATE: Record<SubagentInfo["status"], ChildState> = { working: "running", waiting: "waiting", idle: "done", failed: "failed" };

export function backgroundWork(all: readonly ThreadEvent[]): BackgroundWork {
  const events = withoutRewound(all);
  let lastUser = 0;
  let running = false;
  let subagents: SubagentInfo[] = [];
  const tasks = new Map<string, { title: string; startedAt: string; seq: number; state: ChildState | null }>();
  const commands = new Map<string, BackgroundCommand & { shellId: string | null }>();
  const outputCalls = new Map<string, string>();
  for (const e of events) {
    switch (e.type) {
      case "user_message":
        // A subagent handing back its report is part of the same piece of work, so the
        // others it ran beside stay listed until a person writes again.
        if (!e.from) lastUser = e.seq;
        break;
      case "status_change":
        running = e.to === "running";
        // A stopped runner takes the shells it started with it.
        if (e.to === "stopped" || e.to === "failed" || e.to === "paused") commands.clear();
        break;
      case "subagent_update":
        subagents = e.subagents;
        break;
      case "tool_call": {
        if (TASK_TOOLS.has(e.name)) {
          const title = field(e.input, "description", "prompt") ?? "Subagent";
          tasks.set(e.callId, { title: oneLine(title), startedAt: e.at, seq: e.seq, state: null });
        } else if (e.name === "Bash" && (e.input as { run_in_background?: unknown } | null)?.run_in_background === true) {
          const command = field(e.input, "command") ?? "";
          commands.set(e.callId, { id: e.callId, command: oneLine(command, 200), description: field(e.input, "description"), startedAt: e.at, shellId: null });
        } else if (KILL_TOOLS.has(e.name)) {
          const shell = field(e.input, "shell_id", "bash_id");
          for (const [k, c] of commands) if (c.shellId && c.shellId === shell) commands.delete(k);
        } else if (OUTPUT_TOOLS.has(e.name)) {
          const shell = field(e.input, "bash_id", "shell_id", "task_id");
          if (shell) outputCalls.set(e.callId, shell);
        }
        break;
      }
      case "tool_result": {
        const task = tasks.get(e.callId);
        if (task) task.state = e.isError ? "failed" : "done";
        const cmd = commands.get(e.callId);
        if (cmd) {
          if (e.isError) commands.delete(e.callId);
          else cmd.shellId = /\bID:\s*([\w-]+)/i.exec(text(e.output))?.[1] ?? null;
        }
        const shell = outputCalls.get(e.callId);
        if (shell && /<status>\s*(completed|failed|killed)\s*<\/status>|"status"\s*:\s*"(completed|failed|killed)"/i.test(text(e.output)))
          for (const [k, c] of commands) if (c.shellId === shell) commands.delete(k);
        break;
      }
    }
  }
  const children: ChildWork[] = [];
  for (const s of subagents) {
    const state = RUNNER_STATE[s.status];
    // Finished ones from earlier turns have had their say.
    if ((state === "done" || state === "failed") && Date.parse(s.startedAt) < atOf(events, lastUser)) continue;
    children.push({ id: s.id, title: oneLine(s.task), state, source: "runner", parentId: s.parentId, startedAt: s.startedAt });
  }
  for (const [id, t] of tasks) {
    if (t.seq < lastUser) continue;
    // A Task call with no result once the turn is over was cut short.
    const state: ChildState = t.state ?? (running ? "running" : "failed");
    children.push({ id, title: t.title, state, source: "agent", parentId: null, startedAt: t.startedAt });
  }
  return { children, commands: [...commands.values()].map(({ shellId: _s, ...c }) => c) };
}

function atOf(events: readonly ThreadEvent[], seq: number): number {
  if (!seq) return 0;
  const e = events.find(x => x.seq === seq);
  return e ? Date.parse(e.at) : 0;
}

export function childProgress(children: readonly Pick<ChildWork, "state">[]): ChildProgress {
  const p: ChildProgress = { done: 0, running: 0, waiting: 0, failed: 0, total: children.length };
  for (const c of children) p[c.state]++;
  return p;
}

/** Every child has finished (or there are none): a held message can go now. */
export function childrenSettled(children: readonly Pick<ChildWork, "state">[]): boolean {
  return children.every(c => c.state === "done" || c.state === "failed");
}
