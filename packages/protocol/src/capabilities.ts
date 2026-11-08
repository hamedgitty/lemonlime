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
  /** The agent's fast mode (faster output, more usage), for agents with `fast`. */
  fast: z.boolean().optional(),
});
export type ThreadOptions = z.infer<typeof ThreadOptions>;

/**
 * One model an agent accepts. `tier` is its size class (0 = the biggest), so a thread can
 * move to a model of the same size on another agent; `family` is a word older or shorter
 * names of it contain ("opus" in "claude-opus-4-5"). `context` is a short note for the
 * picker ("1M" for a million-token context window). `older` ones sit under "More models".
 */
export interface AgentModel {
  id: string;
  label: string;
  tier?: number;
  family?: string;
  context?: string;
  older?: boolean;
}

export interface AgentCapabilities {
  /** Model names the agent accepts, best known first. Others can still be typed in. */
  models: AgentModel[];
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
  /** It has a fast mode (the same model, answering faster for more usage). */
  fast: boolean;
}

/**
 * What each agent can be asked for. Model and reasoning are picked when a thread starts and,
 * where `live` says so, changed later; permission modes can change at any time. Served by
 * the runner at `/capabilities` (with the installed version) and used by the apps before a
 * runner exists.
 */
export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {
  // Full names, which the CLI accepts as they are (its short aliases move to newer models).
  "claude-code": {
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", tier: 0, family: "opus", context: "1M" },
      { id: "claude-fable-5-1", label: "Fable 5.1", tier: 0, family: "fable", context: "1M" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", tier: 1, family: "sonnet", context: "1M" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", tier: 2, family: "haiku", context: "1M" },
      { id: "claude-fable-5", label: "Fable 5", tier: 0, context: "1M", older: true },
      { id: "claude-opus-5", label: "Opus 5", tier: 0, context: "1M", older: true },
      { id: "claude-opus-4-8", label: "Opus 4.8", tier: 0, context: "1M", older: true },
      { id: "claude-opus-4-7", label: "Opus 4.7", tier: 0, context: "1M", older: true },
      { id: "claude-sonnet-5", label: "Sonnet 5", tier: 1, context: "1M", older: true },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: 1, context: "1M", older: true },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", tier: 2, older: true },
    ],
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    attachments: { images: true, files: true },
    compact: true,
    permissions: ["ask", "edits", "full", "plan"],
    live: { model: true, reasoning: true },
    questions: true,
    fast: true,
  },
  // The runner replaces these with Codex's own model list when it can read it.
  codex: {
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", tier: 0 },
      { id: "gpt-6-astra", label: "GPT-6-Astra", tier: 1 },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", tier: 2 },
      { id: "gpt-6-sol", label: "GPT-6-Sol", tier: 0, older: true },
      { id: "gpt-6-luna", label: "GPT-6-Luna", tier: 2, older: true },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", tier: 0, older: true },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", tier: 2, older: true },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", tier: 2, older: true },
    ],
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    attachments: { images: true, files: true },
    compact: false,
    // `codex exec` can't stop to ask, so there is no "ask first".
    permissions: ["edits", "full", "plan"],
    live: { model: true, reasoning: true },
    questions: false,
    // Fast mode is Codex's "fast" service tier (`service_tier = "fast"`).
    fast: true,
  },
  // Its models come from its own CLI (`opencode models`); it switches between turns over ACP.
  opencode: {
    models: [],
    reasoning: [],
    attachments: { images: true, files: true },
    compact: false,
    permissions: ["ask", "edits", "full", "plan"],
    live: { model: true, reasoning: false },
    questions: false,
    fast: false,
  },
  acp: {
    models: [],
    reasoning: [],
    attachments: { images: false, files: true },
    compact: false,
    permissions: ["ask", "edits", "full", "plan"],
    live: { model: false, reasoning: false },
    questions: false,
    fast: false,
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
  /** Runners from before fast mode leave it out. */
  fast: z.boolean().optional(),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;
