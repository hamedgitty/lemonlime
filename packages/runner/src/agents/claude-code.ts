import type { NewEvent } from "@lemonlime/protocol";
import { runLineProcess, tryJson } from "./process.ts";
import { turnFailure, type AgentAdapter, type AgentSession, type SessionOptions, type TurnContext } from "./types.ts";

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

class ClaudeCodeSession implements AgentSession {
  private sessionId: string | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.sessionId = opts.saved?.sessionId;
  }

  async runTurn(ctx: TurnContext): Promise<void> {
    const args = ["-p", ctx.prompt, "--output-format", "stream-json", "--verbose"];
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.autonomy === "full") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "acceptEdits");

    let failure: string | null = null;
    let processError: unknown;
    await runLineProcess({
      command: this.opts.command?.[0] ?? "claude",
      args: [...(this.opts.command?.slice(1) ?? []), ...args],
      cwd: this.opts.cwd,
      env: this.opts.env,
      signal: ctx.signal,
      onLine: line => {
        const parsed = parseClaudeLine(line);
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        if (parsed.failure) failure = parsed.failure;
        parsed.events.forEach(e => ctx.emit(e));
      },
    }).catch(err => (processError = err));
    // Claude exits non-zero after a failed result; its own reason beats "exited with code 1".
    const err = turnFailure(failure, processError);
    if (err) throw err;
  }

  saveState(): Record<string, string> {
    return this.sessionId ? { sessionId: this.sessionId } : {};
  }

  async dispose(): Promise<void> {}
}

export interface ParsedLine {
  events: NewEvent[];
  sessionId?: string;
  failure?: string;
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
      .map(c => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : `[${(c as { type?: string })?.type ?? "data"}]`))
      .join("\n");
  }
  return content;
}
