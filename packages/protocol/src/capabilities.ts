import { z } from "zod";
import type { AgentKind } from "./thread.ts";

export const ReasoningLevel = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevel>;

export interface AgentCapabilities {
  /** Model names the agent accepts, best known first. Others can still be typed in. */
  models: { id: string; label: string }[];
  /** Reasoning levels the agent can be set to, if any. */
  reasoning: ReasoningLevel[];
  attachments: { images: boolean; files: boolean };
  /** It can shrink its own conversation (`compact`). */
  compact: boolean;
}

/**
 * What each agent can be asked for when a thread starts. Choices are fixed for the life of
 * the thread. Served by the runner at `/capabilities` (with the installed version) and used
 * by the apps before a runner exists.
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
  },
  opencode: { models: [], reasoning: [], attachments: { images: true, files: true }, compact: false },
  acp: { models: [], reasoning: [], attachments: { images: false, files: true }, compact: false },
};

export const RunnerCapabilities = z.object({
  agent: z.string(),
  agentVersion: z.string().nullable(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  reasoning: z.array(ReasoningLevel),
  attachments: z.object({ images: z.boolean(), files: z.boolean(), maxImageBytes: z.number(), maxFileBytes: z.number(), chunkBytes: z.number() }),
  compact: z.boolean(),
  /** What this thread was started with. */
  model: z.string().nullable(),
  reasoningLevel: ReasoningLevel.nullable(),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;
