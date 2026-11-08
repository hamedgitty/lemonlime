import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCommand, NewEvent, Question, TodoItem } from "@lemonlime/protocol";
import { ApprovalBridge, type ApprovalAnswer, type ApprovalDecision, type ApprovalRequest } from "../approvals.ts";
import { commandsFromNames } from "../composer.ts";
import { selfCommand } from "../self.ts";
import { runLineProcess, tryJson } from "./process.ts";
import {
  applyChange,
  oversizeNotice,
  turnFailure,
  type AgentAdapter,
  type AgentSession,
  type Autonomy,
  type SessionChange,
  type SessionOptions,
  type TurnContext,
} from "./types.ts";

/**
 * Claude Code in print mode: `claude -p --output-format stream-json --verbose`, prompt on stdin.
 * Each turn is one process; `--resume <session_id>` continues the same conversation.
 */
export const claudeCodeAdapter: AgentAdapter = {
  kind: "claude-code",
  createSession(opts) {
    return new ClaudeCodeSession(opts);
  },
};

/** The approval helper Claude Code starts as an MCP server: `lemonlime-runner approval-mcp`. */
const approvalMcp = () => selfCommand("approval-mcp");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Claude Code settings with a PreToolUse hook that runs `lemonlime-runner command-guard` on shell commands. */
export function commandGuardSettings(command: string[] = selfCommand("command-guard")) {
  return { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: command.map(q).join(" "), timeout: 10 }] }] } };
}

const subagentsMcp = () => selfCommand("subagents-mcp");
const SUBAGENTS_SERVER = "lemonlime-subagents";

/** Name Claude Code gives the helper's tool: mcp__<server>__<tool>. */
export const APPROVAL_TOOL = "mcp__lemonlime__approve";
/** Claude Code gives up on an MCP tool call after this; keep it above the approval timeout. */
const APPROVAL_TOOL_TIMEOUT_MS = 35 * 60_000;

class ClaudeCodeSession implements AgentSession {
  private sessionId: string | undefined;
  private bridge: ApprovalBridge | null = null;
  private configDir: string | null = null;
  private ask: ((req: ApprovalRequest) => Promise<ApprovalDecision | ApprovalAnswer>) | null = null;
  private readonly opts: SessionOptions;
  /** What the parser keeps between lines and turns (to-dos, usage, hidden tool calls). */
  private readonly parse = newClaudeParseState();
  /** From the last init message; kept with the session so a restarted runner still knows them. */
  private reported: AgentCommand[] = [];

  constructor(opts: SessionOptions) {
    this.opts = { ...opts };
    this.sessionId = opts.saved?.sessionId;
    try {
      if (opts.saved?.commands) this.reported = commandsFromNames(JSON.parse(opts.saved.commands));
    } catch {
      /* listed again on the next turn */
    }
  }

  setOptions(change: SessionChange): void {
    applyChange(this.opts, change);
  }

  /**
   * Except in read-only side chats, Claude Code hands every permission question to the app
   * through a small MCP tool (--permission-prompt-tool): in print mode nobody else can
   * answer. That is also how its questions (AskUserQuestion) and plans (ExitPlanMode) reach
   * the user, so the tool is there even at full autonomy, where Claude Code only uses it
   * for those two.
   */
  private async mcpConfig(approvals: boolean): Promise<string> {
    if (approvals && !this.bridge) this.bridge = await ApprovalBridge.start(req => (this.ask ? this.ask(req) : Promise.resolve("deny")));
    this.configDir ??= mkdtempSync(join(tmpdir(), "lemonlime-claude-"));
    // The user's plugin servers first, so LemonLime's own always win a name clash.
    const servers: Record<string, unknown> = { ...this.opts.mcpServers };
    if (approvals && this.bridge) {
      servers.lemonlime = {
        command: approvalMcp()[0],
        args: approvalMcp().slice(1),
        env: { LEMONLIME_APPROVAL_URL: this.bridge.url, LEMONLIME_APPROVAL_TOKEN: this.bridge.token },
      };
    }
    if (this.opts.subagents !== false) servers[SUBAGENTS_SERVER] = { command: subagentsMcp()[0], args: subagentsMcp().slice(1) };
    const file = join(this.configDir, approvals ? "mcp-approvals.json" : "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    return file;
  }

  async runTurn(ctx: TurnContext): Promise<void> {
    // The prompt goes on stdin (see runLineProcess), so "-p" here takes no argument.
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (this.opts.model) args.push("--model", this.opts.model);
    // The user's own instructions join the system prompt on every turn.
    if (this.opts.instructions?.trim()) args.push("--append-system-prompt", this.opts.instructions);
    const env: Record<string, string> = { ...this.opts.env };
    // Claude Code's thinking budget, in tokens.
    const thinking = { low: 4_000, medium: 12_000, high: 31_999, xhigh: 31_999, max: 31_999, ultra: 31_999 }[this.opts.reasoning ?? ""];
    if (thinking) env.MAX_THINKING_TOKENS = String(thinking);
    const autonomy = this.opts.autonomy;
    const approvals = autonomy !== "read";
    const pluginServers = Object.keys(this.opts.mcpServers ?? {}).length > 0;
    if (approvals || this.opts.subagents !== false || pluginServers) args.push("--mcp-config", await this.mcpConfig(approvals));
    // Subagent tools, allowed without asking (starting one changes nothing by itself).
    if (this.opts.subagents !== false) args.push("--allowedTools", `mcp__${SUBAGENTS_SERVER}`);
    // Hooks run even with permissions skipped, so the guard holds at every autonomy level.
    if (this.opts.commandGuard !== false) args.push("--settings", JSON.stringify(commandGuardSettings()));
    // Read-only: no editing tools, and with nobody to ask, anything needing permission is refused.
    if (autonomy === "read") args.push("--permission-mode", "default", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit");
    else {
      args.push("--permission-mode", CLAUDE_MODES[autonomy], "--permission-prompt-tool", APPROVAL_TOOL);
      env.MCP_TOOL_TIMEOUT = String(APPROVAL_TOOL_TIMEOUT_MS);
      this.ask = req => this.answer(req, ctx, autonomy);
    }

    let failure: string | null = null;
    let limitReset: string | null = null;
    let processError: unknown;
    await runLineProcess({
      command: this.opts.command?.[0] ?? "claude",
      args: [...(this.opts.command?.slice(1) ?? []), ...args],
      cwd: this.opts.cwd,
      env,
      signal: ctx.signal,
      input: ctx.prompt,
      onLine: line => {
        const parsed = parseClaudeLine(line, this.parse);
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        if (parsed.failure) failure = parsed.failure;
        if (parsed.limitResetAt) limitReset = parsed.limitResetAt;
        if (parsed.commands) this.reported = parsed.commands;
        parsed.events.forEach(e => ctx.emit(e));
      },
      onOversize: bytes => ctx.emit(oversizeNotice(bytes)),
    })
      .catch(err => (processError = err))
      .finally(() => (this.ask = null));
    // Claude exits non-zero after a failed result; its own reason beats "exited with code 1".
    const err = turnFailure(failure, processError, { resetAt: failure ? limitReset : null });
    if (err) throw err;
  }

  /** Answer what Claude Code asked the permission tool. */
  private async answer(req: ApprovalRequest, ctx: TurnContext, autonomy: Autonomy): Promise<ApprovalDecision | ApprovalAnswer> {
    if (req.tool === "AskUserQuestion") return answerQuestions(req.input, ctx);
    // The plan is already on its way to the app (a plan_proposal); the user approves it there.
    if (req.tool === "ExitPlanMode") return { decision: "deny", message: PLAN_SHOWN };
    if (autonomy === "full") return "allow";
    return ctx.requestApproval ? ctx.requestApproval(req) : "deny";
  }

  saveState(): Record<string, string> {
    if (!this.sessionId) return {};
    return this.reported.length ? { sessionId: this.sessionId, commands: JSON.stringify(this.reported.map(c => c.name)) } : { sessionId: this.sessionId };
  }

  commands(): AgentCommand[] {
    return this.reported;
  }

  async dispose(): Promise<void> {
    await this.bridge?.close();
    this.bridge = null;
    if (this.configDir) rmSync(this.configDir, { recursive: true, force: true });
    this.configDir = null;
  }
}

/** Claude Code's permission mode for each autonomy level that asks through the app. */
const CLAUDE_MODES: Record<Exclude<Autonomy, "read">, string> = {
  full: "bypassPermissions",
  edits: "acceptEdits",
  ask: "default",
  plan: "plan",
};

/** What Claude Code is told after proposing a plan, so it stops and waits. */
const PLAN_SHOWN = "LemonLime has shown your plan to the user. Don't start on it: stop here and wait. If they approve it, their next message will say so.";

/** Put the user's answers to an AskUserQuestion call into its input, the way Claude Code reads them. */
async function answerQuestions(input: unknown, ctx: TurnContext): Promise<ApprovalAnswer> {
  const questions = readQuestions(input);
  if (!questions.length || !ctx.askQuestions) return { decision: "deny", message: "Nobody can answer questions right now. Carry on with your best judgement." };
  const answers = await ctx.askQuestions(questions);
  if (!answers) return { decision: "deny", message: "The user didn't answer. Carry on with your best judgement, and say what you assumed." };
  const byQuestion: Record<string, string> = {};
  questions.forEach((q, i) => (byQuestion[q.question] = (answers[i] ?? []).join(", ")));
  return { decision: "allow", updatedInput: { ...(input as Record<string, unknown>), answers: byQuestion } };
}

/** The questions in an AskUserQuestion call's input, cleaned up. */
export function readQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(q => {
    const o = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof o?.question !== "string" || !o.question.trim()) return [];
    const options = (Array.isArray(o.options) ? o.options : []).flatMap(opt => {
      const x = opt as { label?: unknown; description?: unknown };
      return typeof x?.label === "string" && x.label.trim()
        ? [{ label: x.label, ...(typeof x.description === "string" && x.description ? { description: x.description } : {}) }]
        : [];
    });
    return [{ question: o.question, ...(typeof o.header === "string" && o.header ? { header: o.header } : {}), options, multiSelect: o.multiSelect === true }];
  });
}

export interface ParsedLine {
  events: NewEvent[];
  sessionId?: string;
  failure?: string;
  /** The account's usage limit was hit; it lifts at this time (ISO). */
  limitResetAt?: string;
  /** Slash commands listed in the init message. */
  commands?: AgentCommand[];
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/** What parsing keeps from line to line: see parseClaudeLine. */
export interface ClaudeParseState {
  /** Tool calls shown another way (plan, questions, to-dos), whose results are left out too. */
  hidden: Set<string>;
  /** The to-do list kept with Claude Code's task tools, by task id. */
  tasks: Map<string, TodoItem>;
  /** TaskCreate calls waiting for the id their result gives. */
  creating: Map<string, TodoItem>;
  /** Tokens in the context after the latest top-level reply, and the model that wrote it. */
  used: number;
  model: string | null;
}

export function newClaudeParseState(): ClaudeParseState {
  return { hidden: new Set(), tasks: new Map(), creating: new Map(), used: 0, model: null };
}

const TODO_STATUS: Record<string, TodoItem["status"]> = { pending: "pending", in_progress: "in_progress", completed: "completed" };

/** Claude Code's to-do tools: TodoWrite (the whole list each time), and TaskCreate/TaskUpdate. */
function todoEvent(name: string, id: string, input: unknown, state: ClaudeParseState): NewEvent | null | undefined {
  const o = (input ?? {}) as Record<string, unknown>;
  if (name === "TodoWrite") {
    const todos = Array.isArray(o.todos) ? (o.todos as Record<string, unknown>[]) : [];
    const items = todos.flatMap(t => {
      const text = typeof t?.content === "string" ? t.content : typeof t?.activeForm === "string" ? t.activeForm : "";
      return text.trim() ? [{ text, status: TODO_STATUS[String(t.status)] ?? "pending" }] : [];
    });
    return { type: "todo_snapshot", items };
  }
  if (name === "TaskCreate") {
    const text = typeof o.subject === "string" ? o.subject : typeof o.description === "string" ? o.description : "";
    if (text.trim()) state.creating.set(id, { text, status: "pending" });
    return null; // shown once its result gives it an id
  }
  if (name === "TaskUpdate") {
    const key = String(o.taskId ?? o.id ?? "");
    const task = state.tasks.get(key);
    if (!task) return null;
    if (o.status === "deleted") state.tasks.delete(key);
    else
      state.tasks.set(key, { text: typeof o.subject === "string" && o.subject ? o.subject : task.text, status: TODO_STATUS[String(o.status)] ?? task.status });
    return { type: "todo_snapshot", items: [...state.tasks.values()] };
  }
  return undefined;
}

/** Translate one stream-json line into LemonLime events. Unknown lines are ignored. */
export function parseClaudeLine(line: string, state: ClaudeParseState = newClaudeParseState()): ParsedLine {
  const msg = tryJson(line) as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") return { events: [] };
  const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
  const events: NewEvent[] = [];
  if (msg.type === "system" && msg.subtype === "init") {
    const commands = commandsFromNames(msg.slash_commands);
    return { events, ...(sessionId ? { sessionId } : {}), ...(commands.length ? { commands } : {}) };
  }
  if (msg.type === "rate_limit_event") {
    const info = msg.rate_limit_info as { status?: string; resetsAt?: number } | undefined;
    if (info?.status === "rejected" && typeof info.resetsAt === "number") {
      return { events, ...(sessionId ? { sessionId } : {}), limitResetAt: new Date(info.resetsAt * 1000).toISOString() };
    }
    return { events, ...(sessionId ? { sessionId } : {}) };
  }

  if (msg.type === "assistant" || msg.type === "user") {
    // "<synthetic>" messages are written by the CLI itself (e.g. "Login expired"), not the model.
    // The result line that follows carries the same text as the failure, so don't show it twice.
    const message = msg.message as { model?: unknown; usage?: Record<string, unknown>; content?: unknown } | undefined;
    if (message?.model === "<synthetic>") return { events, sessionId };
    // How full the context is: everything the latest top-level reply read and wrote.
    if (msg.type === "assistant" && !msg.parent_tool_use_id && message?.usage) {
      const u = message.usage;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const used = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
      if (used > 0) state.used = used;
      if (typeof message.model === "string") state.model = message.model;
    }
    const content = (message?.content ?? []) as ContentBlock[] | string;
    if (typeof content === "string") return { events, sessionId };
    for (const block of content) {
      if (block.type === "text" && msg.type === "assistant" && typeof block.text === "string" && block.text.trim()) {
        events.push({ type: "agent_message", text: block.text, partial: false });
      } else if (block.type === "thinking" && msg.type === "assistant" && typeof block.thinking === "string" && block.thinking.trim()) {
        // Extended thinking arrives whole, as its own block; redacted thinking has nothing to show.
        events.push({ type: "agent_reasoning", text: block.thinking.trim(), partial: false });
      } else if (block.type === "tool_use") {
        const b = block as Extract<ContentBlock, { type: "tool_use" }>;
        if (b.name === "ExitPlanMode") {
          state.hidden.add(b.id);
          const plan = (b.input as { plan?: unknown } | null)?.plan;
          if (typeof plan === "string" && plan.trim()) events.push({ type: "plan_proposal", plan: plan.trim() });
          continue;
        }
        // Questions reach the app through the permission tool (question_request).
        if (b.name === "AskUserQuestion") {
          state.hidden.add(b.id);
          continue;
        }
        const todo = todoEvent(b.name, b.id, b.input, state);
        if (todo !== undefined) {
          state.hidden.add(b.id);
          if (todo) events.push(todo);
          continue;
        }
        events.push({ type: "tool_call", callId: b.id, name: b.name, input: b.input });
      } else if (block.type === "tool_result") {
        const b = block as Extract<ContentBlock, { type: "tool_result" }>;
        const created = state.creating.get(b.tool_use_id);
        if (created) {
          state.creating.delete(b.tool_use_id);
          const id = /#(\d+)/.exec(String(flattenToolContent(b.content)))?.[1];
          if (id && !b.is_error) {
            state.tasks.set(id, created);
            events.push({ type: "todo_snapshot", items: [...state.tasks.values()] });
          }
        }
        if (state.hidden.has(b.tool_use_id)) {
          state.hidden.delete(b.tool_use_id);
          continue;
        }
        events.push({ type: "tool_result", callId: b.tool_use_id, output: flattenToolContent(b.content), isError: Boolean(b.is_error) });
      }
    }
    return { events, sessionId };
  }

  if (msg.type === "result") {
    const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
    const window = contextWindow(msg.modelUsage, state.model);
    if (window && state.used > 0) events.push({ type: "context_usage", used: Math.min(state.used, window), window });
    if (isError) {
      const text = typeof msg.result === "string" && msg.result ? msg.result : `Claude Code stopped: ${String(msg.subtype ?? "error")}`;
      return { events, sessionId, failure: text };
    }
  }
  return { events, sessionId };
}

/** The context window of the model that wrote the latest reply, from a result line's `modelUsage`. */
function contextWindow(modelUsage: unknown, model: string | null): number | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  const entries = Object.entries(modelUsage as Record<string, { contextWindow?: unknown }>);
  const of = (e: { contextWindow?: unknown } | undefined) => (typeof e?.contextWindow === "number" && e.contextWindow > 0 ? e.contextWindow : null);
  const exact = model ? of((modelUsage as Record<string, { contextWindow?: unknown }>)[model]) : null;
  if (exact) return exact;
  const all = entries.map(([, e]) => of(e)).filter((n): n is number => n !== null);
  return all.length ? Math.max(...all) : null;
}

/** Tool results arrive as a string or a list of text/image blocks; keep text, summarise the rest. */
function flattenToolContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(c =>
        c && typeof c === "object" && (c as { type?: string }).type === "text"
          ? String((c as { text?: unknown }).text ?? "")
          : `[${(c as { type?: string })?.type ?? "data"}]`,
      )
      .join("\n");
  }
  return content;
}
