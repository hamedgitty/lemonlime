import type { HistoryAgent, NewEvent } from "@lemonlime/protocol";
import { capValue } from "../limits.ts";
import { localDate } from "./read.ts";

/** What a scan learns about one saved conversation. */
export interface SessionInfo {
  agent: HistoryAgent;
  sessionId: string;
  title: string;
  cwd: string | null;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  partial: boolean;
  /** Local dates ("YYYY-MM-DD") it had messages on, from what was read. */
  days: Set<string>;
}

/** One event of an imported conversation, with when it originally happened. */
export interface TimedEvent {
  at: string;
  event: NewEvent;
}

/** A whole conversation, read for import. */
export interface Transcript {
  info: SessionInfo;
  events: TimedEvent[];
  /** Only part of it could be read (it was very long). */
  truncated: boolean;
}

/** What an agent's reader found: every conversation it could list. */
export interface AgentListing {
  found: boolean;
  note?: string;
  /** Every conversation, including ones too old to read. */
  total: number;
  /** The ones read (changed within the window asked for). */
  sessions: SessionInfo[];
}

/** Largest tool input or output kept per imported event; the timeline shows a preview. */
export const IMPORT_TOOL_CHARS = 4_000;
/** Largest imported user message. */
export const IMPORT_TEXT_CHARS = 64_000;

/**
 * Builds a conversation's summary and (optionally) its events, one record at a time, the
 * same way for every agent.
 */
export class TranscriptBuilder {
  readonly events: TimedEvent[] = [];
  readonly days = new Set<string>();
  firstAt: string | null = null;
  lastAt: string | null = null;
  firstPrompt: string | null = null;
  messages = 0;

  constructor(private readonly collect: boolean) {}

  /** Note activity at `at` (an ISO time). */
  saw(at: string | null): void {
    if (!at) return;
    if (!this.firstAt || at < this.firstAt) this.firstAt = at;
    if (!this.lastAt || at > this.lastAt) this.lastAt = at;
    this.days.add(localDate(at));
  }

  user(at: string, text: string): void {
    this.messages++;
    if (this.firstPrompt === null && !text.startsWith("/")) this.firstPrompt = text;
    if (this.collect)
      this.events.push({ at, event: { type: "user_message", text: text.length > IMPORT_TEXT_CHARS ? `${text.slice(0, IMPORT_TEXT_CHARS)}…` : text } });
  }

  agent(at: string, text: string): void {
    this.messages++;
    if (this.collect) this.events.push({ at, event: { type: "agent_message", text, partial: false } });
  }

  toolCall(at: string, callId: string, name: string, input: unknown): void {
    if (this.collect) this.events.push({ at, event: { type: "tool_call", callId, name, input: capValue(input ?? null, IMPORT_TOOL_CHARS) } });
  }

  toolResult(at: string, callId: string, output: unknown, isError: boolean): void {
    if (this.collect) this.events.push({ at, event: { type: "tool_result", callId, output: capValue(output ?? null, IMPORT_TOOL_CHARS), isError } });
  }
}

/** Text from a content value that may be a string or a list of `{type: "text", text}` blocks. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const out: string[] = [];
  for (const b of content) {
    if (typeof b === "string") out.push(b);
    else if (b && typeof b === "object") {
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") out.push(block.text);
      else if (block.type === "image" || block.type === "input_image") out.push("[image]");
    }
  }
  return out.join("\n");
}

export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
export const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
