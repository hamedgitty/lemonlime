import { homedir } from "node:os";
import { join } from "node:path";
import type { NewEvent, TodoItem } from "@lemonlime/protocol";
import { runLineProcess, tryJson } from "./process.ts";
import { selfCommand } from "../self.ts";
import { codexMcpFlags } from "../agent-plugins.ts";
import { entries, fileInfo, readLines } from "../history/read.ts";
import {
  applyChange,
  oversizeNotice,
  PLAN_INSTRUCTIONS,
  PlanHold,
  turnFailure,
  type AgentAdapter,
  type AgentSession,
  type SessionChange,
  type SessionOptions,
  type TurnContext,
} from "./types.ts";

/**
 * Codex CLI: `codex exec --json -`, then `codex exec resume --json <thread_id> -` for every
 * later turn so the agent keeps its context. The prompt goes on stdin.
 */
export const codexAdapter: AgentAdapter = {
  kind: "codex",
  createSession(opts) {
    return new CodexSession(opts);
  },
};

/**
 * The command guard (see command-guard.ts) as a Codex PreToolUse hook, in cloud sandboxes.
 * Codex only runs hooks someone has trusted, and trust is kept in its config; in a sandbox
 * that config is the sandbox's own, but rather than write to it the hook is passed for this
 * run with hook trust skipped. That also lets a repository's own hooks run, which in a
 * sandbox the agent can already do itself at full access. On the user's own computer the
 * guard isn't added this way: trusting hooks there is the user's call.
 */
export function codexGuardFlags(enabled: boolean, command: string[] = selfCommand("command-guard")): string[] {
  if (!enabled) return [];
  const hook = `{type="command",command=${tomlString(command.map(shellQuote).join(" "))},timeout=10}`;
  return ["-c", `hooks.PreToolUse=[{matcher="^Bash$",hooks=[${hook}]}]`, "--dangerously-bypass-hook-trust"];
}

const shellQuote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

class CodexSession implements AgentSession {
  private threadId: string | undefined;
  private readonly opts: SessionOptions;
  /** This conversation's session log, once found (see codexContextUsage). */
  private rollout: string | null = null;

  constructor(opts: SessionOptions) {
    this.opts = { ...opts };
    this.threadId = opts.saved?.threadId;
  }

  setOptions(change: SessionChange): void {
    applyChange(this.opts, change);
  }

  async runTurn(ctx: TurnContext): Promise<void> {
    const plan = this.opts.autonomy === "plan";
    // `exec` and `exec resume` share only some flags; the process already runs in cwd,
    // and the sandbox mode is set via a config override that both accept.
    const flags = ["--json", "--skip-git-repo-check"];
    if (this.opts.model) flags.push("--model", this.opts.model);
    if (this.opts.reasoning && /^[a-z]+$/.test(this.opts.reasoning)) flags.push("-c", `model_reasoning_effort="${this.opts.reasoning}"`);
    // The user's own instructions, as developer instructions on every turn; in plan mode,
    // what plan mode means too (Codex has no plan mode of its own in exec).
    const developer = [plan ? PLAN_INSTRUCTIONS : "", this.opts.instructions?.trim() ?? ""].filter(Boolean).join("\n\n");
    if (developer) flags.push("-c", `developer_instructions=${tomlString(developer)}`);
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
        `mcp_servers.lemonlime_subagents.env_vars=${JSON.stringify(["LEMONLIME_RUNNER_URL", "LEMONLIME_THREAD_ID", "LEMONLIME_AGENT_KEY", "LEMONLIME_SUBAGENT_ID", "LEMONLIME_COMPUTER_TOOLS"])}`,
      );
    }
    // The user's plugin servers. Unlike LemonLime's own, their tools aren't pre-approved.
    flags.push(...codexMcpFlags(this.opts.mcpServers ?? {}));
    flags.push(...codexGuardFlags(this.opts.commandGuard !== false && process.env.LEMONLIME_SANDBOX === "1"));
    if (this.opts.autonomy === "full") flags.push("--dangerously-bypass-approvals-and-sandbox");
    else flags.push("-c", this.opts.autonomy === "read" || plan ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"');
    // "-" reads the prompt from stdin, so it can't be taken for a flag or be too long for argv.
    const args = this.threadId ? ["exec", "resume", ...flags, this.threadId, "-"] : ["exec", ...flags, "-"];

    let failure: string | null = null;
    let processError: unknown;
    // In plan mode its last message is the plan.
    const hold = plan ? new PlanHold(e => ctx.emit(e)) : null;
    const todos = new CodexTodos();
    await runLineProcess({
      command: this.opts.command?.[0] ?? "codex",
      args: [...(this.opts.command?.slice(1) ?? []), ...args],
      cwd: this.opts.cwd,
      env: this.opts.env,
      signal: ctx.signal,
      input: ctx.prompt,
      onLine: line => {
        const parsed = parseCodexLine(line, todos);
        if (parsed.threadId) this.threadId = parsed.threadId;
        if (parsed.failure) failure = parsed.failure;
        parsed.events.forEach(e => (hold ? hold.push(e) : ctx.emit(e)));
      },
      onOversize: bytes => ctx.emit(oversizeNotice(bytes)),
    }).catch(err => (processError = err));
    hold?.end(!failure && processError === undefined && !ctx.signal.aborted);
    if (this.threadId) {
      const home = this.opts.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), ".codex");
      this.rollout ??= findRollout(home, this.threadId);
      const usage = this.rollout ? codexContextUsage(this.rollout) : null;
      if (usage) ctx.emit({ type: "context_usage", ...usage });
    }
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
  items?: { text?: string; completed?: boolean }[];
}

/**
 * Codex's plan (its update_plan tool) arrives as a `todo_list` item that is started, updated
 * and completed. Items are only done or not; the first one not done is taken as in progress.
 * Remembers the last list so an unchanged one isn't sent twice.
 */
export class CodexTodos {
  private last = "";
  snapshot(item: CodexItem): NewEvent | null {
    const list = (item.items ?? []).filter(i => typeof i.text === "string" && i.text.trim());
    let current = false;
    const items: TodoItem[] = list.map(i => {
      if (i.completed) return { text: i.text!, status: "completed" };
      const status = current ? "pending" : "in_progress";
      current = true;
      return { text: i.text!, status };
    });
    const key = JSON.stringify(items);
    if (key === this.last) return null;
    this.last = key;
    return { type: "todo_snapshot", items };
  }
}

/** Translate one `codex exec --json` line into LemonLime events. */
export function parseCodexLine(line: string, todos: CodexTodos = new CodexTodos()): { events: NewEvent[]; threadId?: string; failure?: string } {
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
    case "item.updated":
    case "item.completed": {
      const item = msg.item;
      if (!item?.type) break;
      if (item.type === "todo_list") {
        const e = todos.snapshot(item);
        if (e) events.push(e);
        break;
      }
      if (msg.type === "item.updated") break;
      const done = msg.type === "item.completed";
      const id = item.id ?? `${item.type}-${Math.random().toString(36).slice(2, 8)}`;
      switch (item.type) {
        case "agent_message":
          if (done && item.text?.trim()) events.push({ type: "agent_message", text: item.text, partial: false });
          break;
        case "reasoning":
          // A summary of the model's reasoning, sent once it is done.
          if (done && item.text?.trim()) events.push({ type: "agent_reasoning", text: item.text.trim(), partial: false });
          break;
        case "command_execution":
          if (!done) events.push({ type: "tool_call", callId: id, name: "shell", input: { command: item.command } });
          else
            events.push({
              type: "tool_result",
              callId: id,
              output: item.aggregated_output ?? "",
              isError: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
              ...(typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
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
        // Other internal items are not shown either.
      }
      break;
    }
  }
  return { events };
}

const ROLLOUT_DAY = /^\d{1,4}$/;

/**
 * Codex's own log of a conversation: `<codex home>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.
 * Newest days are looked at first, and only a few months back.
 */
export function findRollout(home: string, threadId: string): string | null {
  const desc = (dir: string) =>
    entries(dir)
      .filter(e => e.dir && ROLLOUT_DAY.test(e.name))
      .sort((a, b) => Number(b.name) - Number(a.name));
  let months = 0;
  for (const year of desc(join(home, "sessions")))
    for (const month of desc(year.path)) {
      if (++months > 6) return null;
      for (const day of desc(month.path)) {
        const hit = entries(day.path).find(f => !f.dir && f.name.startsWith("rollout-") && f.name.endsWith(`${threadId}.jsonl`));
        if (hit) return hit.path;
      }
    }
  return null;
}

/**
 * How full the context is, from the newest `token_count` record in a Codex session log
 * (`codex exec --json` doesn't print it): the last request's tokens, of the model's window.
 */
export function codexContextUsage(rollout: string): { used: number; window: number } | null {
  const info = fileInfo(rollout);
  if (!info) return null;
  let found: { used: number; window: number } | null = null;
  for (const line of readLines(rollout, { start: Math.max(0, info.size - 512 * 1024) })) {
    if (!line.includes('"token_count"')) continue;
    const rec = tryJson(line) as { payload?: { type?: string; info?: Record<string, unknown> | null } } | null;
    const t = rec?.payload?.type === "token_count" ? rec.payload.info : null;
    const last = t?.last_token_usage as { total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown } | undefined;
    const window = t?.model_context_window;
    const used = typeof last?.total_tokens === "number" ? last.total_tokens : Number(last?.input_tokens ?? 0) + Number(last?.output_tokens ?? 0) || null;
    if (typeof window === "number" && window > 0 && typeof used === "number" && used > 0) found = { used: Math.min(used, window), window };
  }
  return found;
}

/** A TOML basic string (what Codex's `-c key=value` reads), with every control character escaped. */
export function tomlString(value: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what needs escaping
  const escaped = value.replace(/[\u0000-\u001f\u007f"\\]/g, ch => {
    if (ch === '"') return '\\"';
    if (ch === "\\") return "\\\\";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    if (ch === "\r") return "\\r";
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

/** Codex passes API errors through as a JSON string; pull out the human-readable message. */
function unwrapApiError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const parsed = tryJson(message) as { error?: { message?: unknown }; message?: unknown } | null;
  const inner = parsed?.error?.message ?? parsed?.message;
  return typeof inner === "string" && inner.trim() ? inner : message;
}
