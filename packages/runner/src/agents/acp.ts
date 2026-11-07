import { spawn, type ChildProcess } from "node:child_process";
import type { AgentKind, NewEvent } from "@lemonlime/protocol";
import { lineSplitter } from "./lines.ts";
import { killGently, tryJson } from "./process.ts";
import { AgentError, classifyAgentFailure, oversizeNotice, type AgentAdapter, type AgentSession, type Autonomy, type SessionOptions, type TurnContext } from "./types.ts";

/**
 * Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0 over stdio.
 * One long-lived agent process per thread; each turn is a `session/prompt` request
 * while the agent streams `session/update` notifications.
 */
export function acpAdapter(kind: AgentKind = "acp", defaultCommand?: string[]): AgentAdapter {
  return {
    kind,
    createSession(opts) {
      const command = opts.command?.length ? opts.command : defaultCommand;
      if (!command?.length) throw new AgentError("ACP agents need a command, e.g. --agent-command \"opencode acp\"", "bad_config");
      return new AcpSession({ ...opts, command });
    },
  };
}

/** OpenCode speaks ACP natively via `opencode acp`. */
export const opencodeAdapter = acpAdapter("opencode", ["opencode", "acp"]);

const PROTOCOL_VERSION = 1;
/** Coalesce streamed text so history isn't thousands of one-word events. */
const CHUNK_FLUSH_MS = 120;

type Json = Record<string, unknown>;
interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

class AcpSession implements AgentSession {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId: string | undefined;
  private ready: Promise<void> | null = null;
  private turn: TurnContext | null = null;
  private translator = new AcpTranslator();
  private stderr = "";
  private disposed = false;

  constructor(private readonly opts: SessionOptions & { command: string[] }) {
    this.sessionId = opts.saved?.sessionId;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const [cmd, ...args] = this.opts.command;
      const child = spawn(cmd!, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stderr?.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
      const lines = lineSplitter(
        line => this.onLine(line),
        bytes => this.turn?.emit(oversizeNotice(bytes)),
      );
      child.stdout!.on("data", (d: Buffer) => lines.write(d));
      child.stdout!.on("end", () => lines.end());
      child.on("exit", (code, signal) => {
        // A long-lived ACP agent should never exit on its own while we're using it.
        const how = signal ? `stopped unexpectedly (${signal})` : `exited (code ${code})`;
        const reason = classifyAgentFailure(this.stderr);
        const errCode = this.disposed ? "agent_failed" : reason !== "agent_failed" ? reason : "agent_crashed";
        const err = new AgentError(`${cmd} ${how}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`, errCode);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.child = null;
        this.ready = null;
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", e =>
          reject(new AgentError((e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} is not installed or not on PATH` : e.message, "agent_not_found")),
        );
      });

      await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (this.sessionId) {
        // Try to continue the previous session; fall back to a new one if the agent can't.
        const loaded = await this.request("session/load", { sessionId: this.sessionId, cwd: this.opts.cwd, mcpServers: [] }).then(
          () => true,
          () => false,
        );
        if (loaded) return;
      }
      const res = (await this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] })) as { sessionId?: string };
      if (!res?.sessionId) throw new AgentError("ACP agent did not return a session id");
      this.sessionId = res.sessionId;
    })();
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async runTurn(ctx: TurnContext): Promise<void> {
    await this.start();
    this.turn = ctx;
    this.translator = new AcpTranslator();
    const flush = setInterval(() => this.translator.flushText().forEach(e => ctx.emit(e)), CHUNK_FLUSH_MS);
    const onAbort = () => this.notify("session/cancel", { sessionId: this.sessionId });
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = (await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: ctx.prompt }] })) as {
        stopReason?: string;
      };
      if (res?.stopReason === "refusal") throw new AgentError("The agent refused this request", "refusal");
    } finally {
      clearInterval(flush);
      ctx.signal.removeEventListener("abort", onAbort);
      this.translator.finish().forEach(e => ctx.emit(e));
      this.turn = null;
    }
  }

  saveState(): Record<string, string> {
    return this.sessionId ? { sessionId: this.sessionId } : {};
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.child) killGently(this.child);
  }

  private send(msg: Json): void {
    this.child?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private onLine(line: string): void {
    const msg = tryJson(line) as Json | null;
    if (!msg) return;
    // Response to one of our requests.
    if ("id" in msg && !("method" in msg)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) {
        const reason = String((msg.error as Json).message ?? "ACP error");
        p.reject(new AgentError(reason, classifyAgentFailure(reason)));
      }
      else p.resolve(msg.result);
      return;
    }
    // Request from the agent to us.
    if ("id" in msg && typeof msg.method === "string") {
      this.send({ jsonrpc: "2.0", id: msg.id, ...answerAgentRequest(msg.method, msg.params as Json, this.opts.autonomy) });
      return;
    }
    // Notification.
    if (msg.method === "session/update" && this.turn) {
      const update = (msg.params as Json | undefined)?.update as Json | undefined;
      if (update) this.translator.update(update).forEach(e => this.turn!.emit(e));
    }
  }
}

/** Reply to requests the agent sends us. We advertise no fs/terminal capabilities, so only permissions matter. */
export function answerAgentRequest(method: string, params: Json | undefined, autonomy: Autonomy): { result: unknown } | { error: { code: number; message: string } } {
  if (method === "session/request_permission") {
    const options = (params?.options as { optionId: string; kind: string }[] | undefined) ?? [];
    const toolKind = String((params?.toolCall as Json | undefined)?.kind ?? "");
    const allowed = autonomy === "full" || ["edit", "read", "search", "think", "fetch"].includes(toolKind);
    const pick = allowed
      ? options.find(o => o.kind === "allow_once") ?? options.find(o => o.kind === "allow_always")
      : options.find(o => o.kind === "reject_once") ?? options.find(o => o.kind === "reject_always");
    if (!pick) return { result: { outcome: { outcome: "cancelled" } } };
    return { result: { outcome: { outcome: "selected", optionId: pick.optionId } } };
  }
  return { error: { code: -32601, message: `Method not supported: ${method}` } };
}

/** Turns ACP `session/update` payloads into LemonLime events. */
export class AcpTranslator {
  /** Streamed text not yet sent as a chunk. */
  private text = "";
  /** The whole message so far, sent as one `partial: false` event when it ends. */
  private message = "";
  /** Tool calls announced without their input yet, keyed by id. */
  private readonly waiting = new Map<string, { name: string; input: unknown }>();
  private readonly started = new Set<string>();

  update(u: Json): NewEvent[] {
    const out: NewEvent[] = [];
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as Json | undefined;
        if (c?.type === "text" && typeof c.text === "string") {
          this.text += c.text;
          this.message += c.text;
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = String(u.toolCallId);
        if (u.sessionUpdate === "tool_call") out.push(...this.endMessage());
        // Agents such as OpenCode announce a call with empty or partial input and fill it in
        // while it is still pending, so hold the call until the tool actually starts.
        if (!this.started.has(id)) {
          const prev = this.waiting.get(id);
          const name = prev?.name ?? String(u.title ?? u.kind ?? "tool");
          const input = hasInput(u.rawInput) ? u.rawInput : prev?.input ?? null;
          if (u.status === "in_progress" || u.status === "completed" || u.status === "failed") {
            out.push(...this.endMessage());
            this.waiting.delete(id);
            this.started.add(id);
            out.push({ type: "tool_call", callId: id, name, input });
          } else this.waiting.set(id, { name, input });
        }
        if (this.started.has(id) && (u.status === "completed" || u.status === "failed")) {
          out.push(...this.endMessage());
          out.push(this.result(u));
          this.started.delete(id);
        }
        break;
      }
      // agent_thought_chunk, plan, user_message_chunk, usage_update, available_commands_update: not shown.
    }
    return out;
  }

  /** Emit buffered streamed text as one partial agent message chunk. */
  flushText(): NewEvent[] {
    if (!this.text) return [];
    const text = this.text;
    this.text = "";
    return [{ type: "agent_message", text, partial: true }];
  }

  /** End of turn: close the open message and record calls that never got their input. */
  finish(): NewEvent[] {
    const out = this.endMessage();
    for (const [id, call] of this.waiting) out.push({ type: "tool_call", callId: id, name: call.name, input: call.input });
    this.waiting.clear();
    return out;
  }

  /** Close the open message with one whole copy; clients replace the streamed chunks with it. */
  private endMessage(): NewEvent[] {
    this.text = "";
    if (!this.message) return [];
    const text = this.message;
    this.message = "";
    return [{ type: "agent_message", text, partial: false }];
  }

  private result(u: Json): NewEvent {
    // Prefer the readable content the agent shows its own users; rawOutput is agent-specific.
    const content = Array.isArray(u.content)
      ? (u.content as Json[])
          .map(c => {
            const inner = c.content as Json | undefined;
            if (c.type === "content" && inner?.type === "text") return String(inner.text ?? "");
            if (c.type === "diff") return `edited ${String(c.path ?? "")}`;
            return "";
          })
          .filter(Boolean)
          .join("\n")
      : "";
    return { type: "tool_result", callId: String(u.toolCallId), output: content || (u.rawOutput ?? null), isError: u.status === "failed" };
  }
}

function hasInput(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}
