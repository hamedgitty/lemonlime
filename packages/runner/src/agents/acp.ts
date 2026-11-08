import { spawn, type ChildProcess } from "node:child_process";
import type { AgentKind, NewEvent } from "@lemonlime/protocol";
import { summarizeToolInput, type ApprovalDecision } from "../approvals.ts";
import { dangerousCommand } from "../command-guard.ts";
import { lineSplitter } from "./lines.ts";
import { killGently, tryJson } from "./process.ts";
import {
  AgentError,
  applyChange,
  classifyAgentFailure,
  oversizeNotice,
  PLAN_INSTRUCTIONS,
  PlanHold,
  type AgentAdapter,
  type AgentSession,
  type Autonomy,
  type SessionChange,
  type SessionOptions,
  type TurnContext,
} from "./types.ts";

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
      if (!command?.length) throw new AgentError('ACP agents need a command, e.g. --agent-command "opencode acp"', "bad_config");
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
  /** The conversation was just started (not loaded), so it hasn't seen the user's instructions yet. */
  private needsInstructions = false;
  private readonly opts: SessionOptions & { command: string[] };
  /** The agent's own plan mode, if it offers one, and the mode it was in before. */
  private modes: AgentModes | null = null;

  constructor(opts: SessionOptions & { command: string[] }) {
    this.opts = { ...opts };
    this.sessionId = opts.saved?.sessionId;
  }

  setOptions(change: SessionChange): void {
    applyChange(this.opts, change);
  }

  /** Put the agent in (or out of) its own plan mode, if it has one. False if it has none. */
  private async syncPlanMode(plan: boolean): Promise<boolean> {
    const m = this.modes;
    if (!m?.plan) return false;
    const want = plan ? m.plan : m.normal;
    if (want === m.current) return true;
    const ok = await (
      m.configId
        ? this.request("session/set_config_option", { sessionId: this.sessionId, configId: m.configId, value: want })
        : this.request("session/set_mode", { sessionId: this.sessionId, modeId: want })
    ).then(
      () => true,
      () => false,
    );
    if (ok) m.current = want;
    return ok || !plan;
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
          r => ((this.modes = agentModes(r)), true),
          () => false,
        );
        if (loaded) return;
      }
      const res = (await this.request("session/new", { cwd: this.opts.cwd, mcpServers: [] })) as { sessionId?: string };
      if (!res?.sessionId) throw new AgentError("ACP agent did not return a session id");
      this.sessionId = res.sessionId;
      this.modes = agentModes(res);
      this.needsInstructions = Boolean(this.opts.instructions?.trim());
    })();
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async runTurn(ctx: TurnContext): Promise<void> {
    await this.start();
    const plan = this.opts.autonomy === "plan";
    // The agent's own plan mode if it has one; otherwise LemonLime says what plan mode means
    // (and refuses anything but looking, see answerAgentRequest).
    const nativePlan = await this.syncPlanMode(plan);
    // In plan mode the last message is the plan, so it isn't streamed.
    const hold = plan ? new PlanHold(e => ctx.emit(e)) : null;
    const emit = (e: NewEvent) => (hold ? hold.push(e) : ctx.emit(e));
    this.turn = { ...ctx, emit };
    this.translator = new AcpTranslator();
    const flush = setInterval(() => this.translator.flushText().forEach(emit), CHUNK_FLUSH_MS);
    const onAbort = () => this.notify("session/cancel", { sessionId: this.sessionId });
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    // ACP has no system prompt, so a new conversation's first message carries the user's instructions.
    let text = this.needsInstructions ? withInstructions(this.opts.instructions!, ctx.prompt) : ctx.prompt;
    if (plan && !nativePlan) text = `${PLAN_INSTRUCTIONS}\n\n---\n\n${text}`;
    this.needsInstructions = false;
    let finished = false;
    try {
      const res = (await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] })) as {
        stopReason?: string;
      };
      if (res?.stopReason === "refusal") throw new AgentError("The agent refused this request", "refusal");
      finished = res?.stopReason !== "cancelled" && !ctx.signal.aborted;
    } finally {
      clearInterval(flush);
      ctx.signal.removeEventListener("abort", onAbort);
      this.translator.finish().forEach(emit);
      hold?.end(finished);
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
      } else p.resolve(msg.result);
      return;
    }
    // Request from the agent to us.
    if ("id" in msg && typeof msg.method === "string") {
      const params = msg.params as Json | undefined;
      // The command guard holds at every autonomy level, for agents that ask before running commands.
      const blocked = msg.method === "session/request_permission" && this.opts.commandGuard !== false ? blockedCommand(params) : null;
      if (blocked) {
        this.turn?.emit({ type: "notice", code: "command_blocked", message: `LemonLime blocked a command the agent wanted to run. ${blocked}` });
        this.send({ jsonrpc: "2.0", id: msg.id, ...answerAgentRequest(msg.method as string, params, "edits", "deny", true) });
        return;
      }
      if (msg.method === "session/request_permission" && needsApproval(params, this.opts.autonomy)) {
        // Ask the user; the agent waits for our answer.
        const toolCall = (params?.toolCall as Json | undefined) ?? {};
        const known = this.translator.knownCall(String(toolCall.toolCallId ?? ""));
        const tool = String(toolCall.title ?? known?.name ?? toolCall.kind ?? "tool");
        const input = toolCall.rawInput ?? known?.input ?? null;
        const ask = this.turn?.requestApproval;
        const decision = ask ? ask({ tool, input, summary: summarizeToolInput(tool, input) }) : Promise.resolve<ApprovalDecision>("deny");
        void decision
          .catch((): ApprovalDecision => "deny")
          .then(d => this.send({ jsonrpc: "2.0", id: msg.id, ...answerAgentRequest(msg.method as string, params, this.opts.autonomy, d) }));
        return;
      }
      this.send({ jsonrpc: "2.0", id: msg.id, ...answerAgentRequest(msg.method, params, this.opts.autonomy) });
      return;
    }
    // Notification.
    if (msg.method === "session/update" && this.turn) {
      const update = (msg.params as Json | undefined)?.update as Json | undefined;
      if (update) this.translator.update(update).forEach(e => this.turn!.emit(e));
    }
  }
}

interface AgentModes {
  /** Set through `session/set_config_option` with this id, or else `session/set_mode`. */
  configId: string | null;
  current: string;
  /** The mode it started in, to go back to after planning. */
  normal: string;
  plan: string | null;
}

/**
 * The agent's session modes, from a `session/new` (or load) result: newer agents list them
 * as a config option in the "mode" category, older ones as `modes`. Null without any.
 */
export function agentModes(result: unknown): AgentModes | null {
  const r = (result ?? {}) as Json;
  const isPlan = (id: string, name?: unknown) => /^plan$/i.test(id) || (typeof name === "string" && /^plan$/i.test(name));
  const options = Array.isArray(r.configOptions) ? (r.configOptions as Json[]) : [];
  const mode = options.find(o => o.category === "mode" && typeof o.currentValue === "string");
  if (mode) {
    const values = (Array.isArray(mode.options) ? (mode.options as Json[]) : []).filter(o => typeof o.value === "string");
    const plan = values.find(o => isPlan(String(o.value), o.name));
    const current = String(mode.currentValue);
    return { configId: String(mode.id), current, normal: current, plan: plan ? String(plan.value) : null };
  }
  const legacy = r.modes as { currentModeId?: unknown; availableModes?: Json[] } | undefined;
  if (legacy && typeof legacy.currentModeId === "string") {
    const plan = (legacy.availableModes ?? []).find(m => typeof m.id === "string" && isPlan(m.id, m.name));
    return { configId: null, current: legacy.currentModeId, normal: legacy.currentModeId, plan: plan ? String(plan.id) : null };
  }
  return null;
}

/** The first message of a new conversation, with the user's own instructions ahead of it. */
export function withInstructions(instructions: string, prompt: string): string {
  return `Instructions from the user for this whole conversation (follow them in every reply):\n\n${instructions.trim()}\n\n---\n\n${prompt}`;
}

/** Why the command in a permission request is blocked by the command guard, or null. */
export function blockedCommand(params: Json | undefined): string | null {
  const call = (params?.toolCall as Json | undefined) ?? {};
  const input = call.rawInput as Json | undefined;
  const raw = input && typeof input === "object" ? (input.command ?? input.cmd) : undefined;
  const command = Array.isArray(raw) ? raw.map(String).join(" ") : typeof raw === "string" ? raw : "";
  return command ? dangerousCommand(command) : null;
}

/** Tool kinds that never need asking: they only read, or edit files (which "edits" allows). */
const SAFE_KINDS = ["edit", "read", "search", "think", "fetch"];
/** What a read-only session (or one planning) may do without anyone being asked. */
const READ_KINDS = ["read", "search", "think", "fetch"];

/** True when a permission request has to go to the user rather than be answered by policy. */
export function needsApproval(params: Json | undefined, autonomy: Autonomy): boolean {
  if (autonomy === "full" || autonomy === "read" || autonomy === "plan") return false;
  const toolKind = String((params?.toolCall as Json | undefined)?.kind ?? "");
  return !(autonomy === "ask" ? READ_KINDS : SAFE_KINDS).includes(toolKind);
}

/**
 * Reply to requests the agent sends us. We advertise no fs/terminal capabilities, so only
 * permissions matter. `decision` is the user's answer for requests that needed asking;
 * without one, such requests are declined.
 */
export function answerAgentRequest(
  method: string,
  params: Json | undefined,
  autonomy: Autonomy,
  decision?: ApprovalDecision,
  /** Refuse whatever the policy would say (the command guard blocked it). */
  refuse = false,
): { result: unknown } | { error: { code: number; message: string } } {
  if (method === "session/request_permission") {
    const options = (params?.options as { optionId: string; kind: string }[] | undefined) ?? [];
    const kind = String((params?.toolCall as Json | undefined)?.kind ?? "");
    const looking = autonomy === "read" || autonomy === "plan";
    const allowed = refuse ? false : looking ? READ_KINDS.includes(kind) : needsApproval(params, autonomy) ? decision === "allow" : true;
    const pick = allowed
      ? (options.find(o => o.kind === "allow_once") ?? options.find(o => o.kind === "allow_always"))
      : (options.find(o => o.kind === "reject_once") ?? options.find(o => o.kind === "reject_always"));
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
  private readonly startedCalls = new Map<string, { name: string; input: unknown }>();

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
          const input = hasInput(u.rawInput) ? u.rawInput : (prev?.input ?? null);
          if (u.status === "in_progress" || u.status === "completed" || u.status === "failed") {
            out.push(...this.endMessage());
            this.waiting.delete(id);
            this.started.add(id);
            this.startedCalls.set(id, { name, input });
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
      // The agent's plan: its to-do list, whole each time.
      case "plan": {
        const entries = Array.isArray(u.entries) ? (u.entries as Json[]) : [];
        const items = entries.flatMap(e =>
          typeof e.content === "string" && e.content.trim()
            ? [{ text: e.content, status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending" } as const]
            : [],
        );
        out.push({ type: "todo_snapshot", items });
        break;
      }
      case "usage_update":
        if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0 && u.used >= 0) {
          out.push({ type: "context_usage", used: Math.min(Math.round(u.used), Math.round(u.size)), window: Math.round(u.size) });
        }
        break;
      // agent_thought_chunk, user_message_chunk, available_commands_update: not shown.
    }
    return out;
  }

  /** Name and latest input of a tool call this turn has seen, if any. */
  knownCall(id: string): { name: string; input: unknown } | undefined {
    return this.waiting.get(id) ?? this.startedCalls.get(id);
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
