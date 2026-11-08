import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewEvent } from "@lemonlime/protocol";
import { ApprovalBridge, type ApprovalDecision, type ApprovalRequest } from "../approvals.ts";
import { selfCommand } from "../self.ts";
import { runLineProcess, tryJson } from "./process.ts";
import { oversizeNotice, turnFailure, type AgentAdapter, type AgentSession, type SessionOptions, type TurnContext } from "./types.ts";

/**
 * Claude Code in print mode: `claude -p <prompt> --output-format stream-json --verbose`.
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
  private configFile: string | null = null;
  private ask: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.sessionId = opts.saved?.sessionId;
  }

  /**
   * At autonomy "edits" Claude Code edits files freely but asks before anything else
   * (most importantly, running commands). In print mode nobody can answer, so we hand
   * the question to the app through a small MCP tool.
   */
  private async mcpConfig(approvals: boolean): Promise<string> {
    if (approvals && !this.bridge) this.bridge = await ApprovalBridge.start(req => (this.ask ? this.ask(req) : Promise.resolve("deny")));
    this.configDir ??= mkdtempSync(join(tmpdir(), "lemonlime-claude-"));
    const servers: Record<string, unknown> = {};
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
    const args = ["-p", ctx.prompt, "--output-format", "stream-json", "--verbose"];
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (this.opts.model) args.push("--model", this.opts.model);
    // The user's own instructions join the system prompt on every turn.
    if (this.opts.instructions?.trim()) args.push("--append-system-prompt", this.opts.instructions);
    const env: Record<string, string> = { ...this.opts.env };
    // Claude Code's thinking budget, in tokens.
    const thinking = { low: 4_000, medium: 12_000, high: 31_999, xhigh: 31_999, max: 31_999, ultra: 31_999 }[this.opts.reasoning ?? ""];
    if (thinking) env.MAX_THINKING_TOKENS = String(thinking);
    // Subagent tools, allowed without asking (starting one changes nothing by itself).
    if (this.opts.subagents !== false && this.opts.autonomy !== "edits") args.push("--mcp-config", await this.mcpConfig(false));
    if (this.opts.subagents !== false) args.push("--allowedTools", `mcp__${SUBAGENTS_SERVER}`);
    // Hooks run even with permissions skipped, so the guard holds at every autonomy level.
    if (this.opts.commandGuard !== false) args.push("--settings", JSON.stringify(commandGuardSettings()));
    if (this.opts.autonomy === "full") args.push("--dangerously-skip-permissions");
    // Read-only: no editing tools, and with nobody to ask, anything needing permission is refused.
    else if (this.opts.autonomy === "read") args.push("--permission-mode", "default", "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit");
    else {
      args.push("--permission-mode", "acceptEdits", "--mcp-config", await this.mcpConfig(true), "--permission-prompt-tool", APPROVAL_TOOL);
      env.MCP_TOOL_TIMEOUT = String(APPROVAL_TOOL_TIMEOUT_MS);
      this.ask = req => (ctx.requestApproval ? ctx.requestApproval(req) : Promise.resolve("deny"));
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
      onLine: line => {
        const parsed = parseClaudeLine(line);
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        if (parsed.failure) failure = parsed.failure;
        if (parsed.limitResetAt) limitReset = parsed.limitResetAt;
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

  saveState(): Record<string, string> {
    return this.sessionId ? { sessionId: this.sessionId } : {};
  }

  async dispose(): Promise<void> {
    await this.bridge?.close();
    this.bridge = null;
    if (this.configDir) rmSync(this.configDir, { recursive: true, force: true });
    this.configDir = null;
  }
}

export interface ParsedLine {
  events: NewEvent[];
  sessionId?: string;
  failure?: string;
  /** The account's usage limit was hit; it lifts at this time (ISO). */
  limitResetAt?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/** Translate one stream-json line into LemonLime events. Unknown lines are ignored. */
export function parseClaudeLine(line: string): ParsedLine {
  const msg = tryJson(line) as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") return { events: [] };
  const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
  const events: NewEvent[] = [];
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
    if ((msg.message as { model?: unknown } | undefined)?.model === "<synthetic>") return { events, sessionId };
    const content = ((msg.message as { content?: unknown })?.content ?? []) as ContentBlock[] | string;
    if (typeof content === "string") return { events, sessionId };
    for (const block of content) {
      if (block.type === "text" && msg.type === "assistant" && typeof block.text === "string" && block.text.trim()) {
        events.push({ type: "agent_message", text: block.text, partial: false });
      } else if (block.type === "tool_use") {
        const b = block as Extract<ContentBlock, { type: "tool_use" }>;
        events.push({ type: "tool_call", callId: b.id, name: b.name, input: b.input });
      } else if (block.type === "tool_result") {
        const b = block as Extract<ContentBlock, { type: "tool_result" }>;
        events.push({ type: "tool_result", callId: b.tool_use_id, output: flattenToolContent(b.content), isError: Boolean(b.is_error) });
      }
    }
    return { events, sessionId };
  }

  if (msg.type === "result") {
    const isError = msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
    if (isError) {
      const text = typeof msg.result === "string" && msg.result ? msg.result : `Claude Code stopped: ${String(msg.subtype ?? "error")}`;
      return { events, sessionId, failure: text };
    }
  }
  return { events, sessionId };
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
