import { randomUUID } from "node:crypto";
import type { NewEvent } from "@lemonlime/protocol";
import type { AgentAdapter, AgentSession, SessionOptions } from "./agents/index.ts";

/** A subagent may start its own, once: main thread → child → grandchild. */
export const MAX_SUBAGENT_DEPTH = 2;
/** Children one agent may have at a time. */
export const MAX_SUBAGENT_CHILDREN = 3;

export interface SubagentInfo {
  id: string;
  /** Null when the main thread's agent started it. */
  parentId: string | null;
  depth: number;
  task: string;
  status: "working" | "idle" | "failed";
  lastReply: string | null;
  startedAt: string;
}

interface Subagent extends SubagentInfo {
  session: AgentSession;
  inbox: string[];
  turns: number;
}

export interface SubagentsOptions {
  adapter: AgentAdapter;
  session: Omit<SessionOptions, "cwd" | "saved">;
  cwd: string;
  /** Hand a finished child's reply to the main thread (it joins the queue like any message). */
  toMain: (text: string, id: string) => void;
  /** Something for the thread's history, e.g. "started a subagent". */
  notice: (code: string, message: string) => void;
}

const FRAMING = (task: string) =>
  `You are a subagent: another agent in this same project gave you one task. Do it, then reply with what you did and what you found, briefly, for that agent to read. You share the working folder with it, so only touch what the task needs.\n\nTask: ${task}`;

/**
 * Subagents: extra agent conversations an agent starts to work on part of a task. They
 * run here in the runner, so they carry on, and their replies reach whoever started them,
 * even with no app open.
 */
export class Subagents {
  private agents = new Map<string, Subagent>();
  /** request id → subagent id, so a retried spawn never starts a second one. */
  private byRequest = new Map<string, string>();

  constructor(private readonly opts: SubagentsOptions) {}

  list(parentId?: string | null): SubagentInfo[] {
    return [...this.agents.values()]
      .filter(a => parentId === undefined || a.parentId === parentId)
      .map(({ session: _s, inbox: _i, turns: _t, ...info }) => info);
  }

  spawn(o: { requestId: string; task: string; parentId: string | null }): { id: string; created: boolean } | { error: string } {
    const known = this.byRequest.get(o.requestId);
    if (known) return { id: known, created: false };
    const parent = o.parentId ? this.agents.get(o.parentId) : null;
    if (o.parentId && !parent) return { error: "unknown parent subagent" };
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > MAX_SUBAGENT_DEPTH) return { error: `Subagents can only go ${MAX_SUBAGENT_DEPTH} levels deep; do this part yourself.` };
    const siblings = [...this.agents.values()].filter(a => a.parentId === o.parentId && a.status === "working");
    if (siblings.length >= MAX_SUBAGENT_CHILDREN) return { error: `You already have ${MAX_SUBAGENT_CHILDREN} subagents working; wait for one to reply.` };
    const id = `sub-${randomUUID().slice(0, 8)}`;
    const env = { ...this.opts.session.env, LEMONLIME_SUBAGENT_ID: id };
    const session = this.opts.adapter.createSession({ ...this.opts.session, env, cwd: this.opts.cwd, saved: {} });
    const agent: Subagent = {
      id,
      parentId: o.parentId,
      depth,
      task: o.task.slice(0, 2000),
      status: "working",
      lastReply: null,
      startedAt: new Date().toISOString(),
      session,
      inbox: [],
      turns: 0,
    };
    this.agents.set(id, agent);
    this.byRequest.set(o.requestId, id);
    this.opts.notice("subagent_started", `Started a subagent for: ${agent.task.slice(0, 200)}`);
    void this.run(agent, FRAMING(agent.task));
    return { id, created: true };
  }

  /** Send a follow-up to a subagent; it runs once the subagent is free. */
  message(id: string, text: string, fromParentId: string | null): boolean | { error: string } {
    const agent = this.agents.get(id);
    if (!agent) return false;
    if (agent.parentId !== fromParentId) return { error: "Only the agent that started a subagent can message it." };
    if (agent.status === "working") agent.inbox.push(text);
    else void this.run(agent, text);
    return true;
  }

  async close(): Promise<void> {
    for (const a of this.agents.values()) await a.session.dispose().catch(() => undefined);
  }

  private async run(agent: Subagent, prompt: string): Promise<void> {
    agent.status = "working";
    agent.turns++;
    let reply = "";
    try {
      await agent.session.runTurn({
        prompt,
        signal: new AbortController().signal,
        emit: (e: NewEvent) => {
          if (e.type === "agent_message" && !e.partial) reply = e.text;
        },
      });
      agent.status = "idle";
    } catch (err) {
      agent.status = "failed";
      reply = `It stopped with an error: ${err instanceof Error ? err.message : String(err)}`;
    }
    agent.lastReply = reply || "(no reply)";
    this.deliver(agent);
    const next = agent.inbox.shift();
    if (next !== undefined && agent.status !== "failed") void this.run(agent, next);
  }

  /** Give the reply to whoever started the subagent. */
  private deliver(agent: Subagent): void {
    const text = `Subagent ${agent.id} (task: ${agent.task.slice(0, 120)}) ${agent.status === "failed" ? "failed" : "replied"}:\n\n${agent.lastReply}`;
    this.opts.notice("subagent_replied", `A subagent ${agent.status === "failed" ? "failed" : "finished"}: ${agent.task.slice(0, 120)}`);
    if (!agent.parentId) return this.opts.toMain(text, `${agent.id}-${agent.turns}`);
    const parent = this.agents.get(agent.parentId);
    if (!parent) return;
    if (parent.status === "working") parent.inbox.push(text);
    else void this.run(parent, text);
  }
}
