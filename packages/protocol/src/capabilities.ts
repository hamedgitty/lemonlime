import { z } from "zod";
import type { AgentKind } from "./thread.ts";

export const ReasoningLevel = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;

/**
 * How much the agent may do without asking.
 * - ask:   asks before editing files and before running commands
 * - edits: edits files freely, asks before running commands
 * - full:  anything, without asking (isolated sandboxes)
 * - plan:  looks around and writes a plan, changes nothing until the user says go
 */
export const PermissionMode = z.enum(["ask", "edits", "full", "plan"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const PERMISSION_MODES: Record<PermissionMode, { label: string; hint: string }> = {
  ask: { label: "Ask first", hint: "Asks before editing files or running commands" },
  edits: { label: "Accept edits", hint: "Edits files freely, asks before running commands" },
  full: { label: "Full access", hint: "Edits and runs anything without asking" },
  plan: { label: "Plan", hint: "Reads and plans, changes nothing until you say go" },
};

/**
 * A thread's current choices. They can change between turns (`set_options`); a change made
 * while the agent works applies from its next turn. `model: null` is the agent's default.
 * `exitPlanTo`: the mode to go back to when a plan is approved.
 */
export const ThreadOptions = z.object({
  model: z.string().nullable(),
  reasoning: ReasoningLevel.nullable(),
  permission: PermissionMode,
  exitPlanTo: PermissionMode.optional(),
});
export type ThreadOptions = z.infer<typeof ThreadOptions>;

export interface AgentCapabilities {
  /** Model names the agent accepts, best known first. Others can still be typed in. */
  models: { id: string; label: string }[];
  /** Reasoning levels the agent can be set to, if any. */
  reasoning: ReasoningLevel[];
  attachments: { images: boolean; files: boolean };
  /** It can shrink its own conversation (`compact`). */
  compact: boolean;
  /** Permission modes it can run in. */
  permissions: PermissionMode[];
  /** What can be changed in the middle of a thread (permission modes always can). */
  live: { model: boolean; reasoning: boolean };
  /** It can ask the user multiple-choice questions mid-turn (`question_request`). */
  questions: boolean;
}

/**
 * What each agent can be asked for. Model and reasoning are picked when a thread starts and,
 * where `live` says so, changed later; permission modes can change at any time. Served by
 * the runner at `/capabilities` (with the installed version) and used by the apps before a
 * runner exists.
 */
export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  "claude-code": {
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    reasoning: ["low", "medium", "high"],
    attachments: { images: true, files: true },
    compact: true,
    permissions: ["ask", "edits", "full", "plan"],
    live: { model: true, reasoning: true },
    questions: true,
  },
  // The runner replaces these with Codex's own model list when it can read it.
  codex: {
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
    ],
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    attachments: { images: true, files: true },
    compact: false,
    // `codex exec` can't stop to ask, so there is no "ask first".
    permissions: ["edits", "full", "plan"],
    live: { model: true, reasoning: true },
    questions: false,
  },
  opencode: {
    models: [],
    reasoning: [],
    attachments: { images: true, files: true },
    compact: false,
    permissions: ["ask", "edits", "full", "plan"],
    live: { model: false, reasoning: false },
    questions: false,
  },
  acp: {
    models: [],
    reasoning: [],
    attachments: { images: false, files: true },
    compact: false,
    permissions: ["ask", "edits", "full", "plan"],
    live: { model: false, reasoning: false },
    questions: false,
  },
};

export const RunnerCapabilities = z.object({
  agent: z.string(),
  agentVersion: z.string().nullable(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  reasoning: z.array(ReasoningLevel),
  attachments: z.object({ images: z.boolean(), files: z.boolean(), maxImageBytes: z.number(), maxFileBytes: z.number(), chunkBytes: z.number() }),
  compact: z.boolean(),
  /** What this thread uses now (it may have changed since it started). */
  model: z.string().nullable(),
  reasoningLevel: ReasoningLevel.nullable(),
  permission: PermissionMode,
  permissions: z.array(PermissionMode),
  live: z.object({ model: z.boolean(), reasoning: z.boolean() }),
  questions: z.boolean(),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;
