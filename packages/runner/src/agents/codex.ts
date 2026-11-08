import type { NewEvent } from "@lemonlime/protocol";
import { runLineProcess, tryJson } from "./process.ts";
import { selfCommand } from "../self.ts";
import { codexMcpFlags } from "../agent-plugins.ts";
import { oversizeNotice, turnFailure, type AgentAdapter, type AgentSession, type SessionOptions, type TurnContext } from "./types.ts";

/**
 * Codex CLI: `codex exec --json <prompt>`, then `codex exec resume <thread_id> --json <prompt>`
 * for every later turn so the agent keeps its context.
 */
export const codexAdapter: AgentAdapter = {
  kind: "codex",
  createSession(opts) {
    return new CodexSession(opts);
  },
};

class CodexSession implements AgentSession {
  private threadId: string | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.threadId = opts.saved?.threadId;
  }

  async runTurn(ctx: TurnContext): Promise<void> {
    // `exec` and `exec resume` share only some flags; the process already runs in cwd,
    // and the sandbox mode is set via a config override that both accept.
    const flags = ["--json", "--skip-git-repo-check"];
    if (this.opts.model) flags.push("--model", this.opts.model);
    if (this.opts.reasoning && /^[a-z]+$/.test(this.opts.reasoning)) flags.push("-c", `model_reasoning_effort="${this.opts.reasoning}"`);
    if (this.opts.subagents !== false) {
      const [cmd, ...rest] = selfCommand("subagents-mcp");
      flags.push(
        "-c",
        `mcp_servers.lemonlime_subagents.command=${JSON.stringify(cmd)}`,
        "-c",
        `mcp_servers.lemonlime_subagents.args=${JSON.stringify(rest)}`,
        // In exec mode nobody can approve a tool call, and LemonLime's own tools are safe to run
        // (computer access is decided in the user's desktop app), so they're pre-approved.
        "-c",
        'mcp_servers.lemonlime_subagents.default_tools_approval_mode="approve"',
        // Codex starts MCP servers with a clean environment; these say which thread and runner
        // this is, passed by name so the secret never appears in a command line.
        "-c",
        `mcp_servers.lemonlime_subagents.env_vars=${JSON.stringify(["LEMONLIME_RUNNER_URL", "LEMONLIME_THREAD_ID", "LEMONLIME_THREAD_SECRET", "LEMONLIME_SUBAGENT_ID", "LEMONLIME_COMPUTER_TOOLS"])}`,
      );
    }
    // The user's plugin servers. Unlike LemonLime's own, their tools aren't pre-approved.
    flags.push(...codexMcpFlags(this.opts.mcpServers ?? {}));
    if (this.opts.autonomy === "full") flags.push("--dangerously-bypass-approvals-and-sandbox");
    else flags.push("-c", this.opts.autonomy === "read" ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"');
    const args = this.threadId ? ["exec", "resume", ...flags, this.threadId, ctx.prompt] : ["exec", ...flags, ctx.prompt];

    let failure: string | null = null;
    let processError: unknown;
    await runLineProcess({
      command: this.opts.command?.[0] ?? "codex",
      args: [...(this.opts.command?.slice(1) ?? []), ...args],
      cwd: this.opts.cwd,
      env: this.opts.env,
      signal: ctx.signal,
      onLine: line => {
        const parsed = parseCodexLine(line);
        if (parsed.threadId) this.threadId = parsed.threadId;
        if (parsed.failure) failure = parsed.failure;
        parsed.events.forEach(e => ctx.emit(e));
      },
      onOversize: bytes => ctx.emit(oversizeNotice(bytes)),
    }).catch(err => (processError = err));
    // Codex exits non-zero after turn.failed; its own reason beats "exited with code 1".
    const err = turnFailure(failure, processError);
    if (err) throw err;
  }

  saveState(): Record<string, string> {
    return this.threadId ? { threadId: this.threadId } : {};
  }

  async dispose(): Promise<void> {}
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: { path: string; kind: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string | null;
  message?: string;
  query?: string;
}

/** Translate one `codex exec --json` line into LemonLime events. */
export function parseCodexLine(line: string): { events: NewEvent[]; threadId?: string; failure?: string } {
  const msg = tryJson(line) as { type?: string; thread_id?: string; item?: CodexItem; error?: { message?: string }; message?: string } | null;
  if (!msg || typeof msg !== "object") return { events: [] };
  const events: NewEvent[] = [];

  switch (msg.type) {
    case "thread.started":
      return { events, threadId: msg.thread_id };
    case "turn.failed":
      return { events, failure: unwrapApiError(msg.error?.message) ?? "Codex turn failed" };
    case "error":
      return { events, failure: unwrapApiError(msg.message) ?? "Codex reported an error" };
    case "item.started":
    case "item.completed": {
      const item = msg.item;
      if (!item?.type) break;
      const done = msg.type === "item.completed";
      const id = item.id ?? `${item.type}-${Math.random().toString(36).slice(2, 8)}`;
      switch (item.type) {
        case "agent_message":
          if (done && item.text?.trim()) events.push({ type: "agent_message", text: item.text, partial: false });
          break;
        case "command_execution":
          if (!done) events.push({ type: "tool_call", callId: id, name: "shell", input: { command: item.command } });
          else
            events.push({
              type: "tool_result",
              callId: id,
              output: item.aggregated_output ?? "",
              isError: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
            });
          break;
        case "file_change":
          if (done) {
            events.push({ type: "tool_call", callId: id, name: "edit_files", input: { changes: item.changes ?? [] } });
            events.push({ type: "tool_result", callId: id, output: item.status ?? "completed", isError: item.status === "failed" });
          }
          break;
        case "mcp_tool_call":
          if (!done) events.push({ type: "tool_call", callId: id, name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, input: item.arguments ?? null });
          else {
            const err = typeof item.error === "string" ? item.error : item.error?.message;
            events.push({ type: "tool_result", callId: id, output: err ?? item.result ?? null, isError: Boolean(err) || item.status === "failed" });
          }
          break;
        case "web_search":
          if (done) {
            events.push({ type: "tool_call", callId: id, name: "web_search", input: { query: item.query } });
            events.push({ type: "tool_result", callId: id, output: "done", isError: false });
          }
          break;
        // "error" items are Codex's non-fatal warnings (unknown model metadata, skills trimmed to
        // fit, ...). They don't end the turn, so they aren't LemonLime errors; real failures
        // arrive as top-level "error" / "turn.failed" lines.
        // reasoning, todo_list and other internal items are not shown either.
      }
      break;
    }
  }
  return { events };
}

/** Codex passes API errors through as a JSON string; pull out the human-readable message. */
function unwrapApiError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const parsed = tryJson(message) as { error?: { message?: unknown }; message?: unknown } | null;
  const inner = parsed?.error?.message ?? parsed?.message;
  return typeof inner === "string" && inner.trim() ? inner : message;
}
