import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_CAPABILITIES, ReasoningLevel, type AgentKind, type RunnerCapabilities } from "@lemonlime/protocol";
import { ATTACHMENT_CHUNK_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from "./attachments.ts";

/** Codex keeps the models the account can use in a cache; read it when it's there. */
export function codexModels(
  home = process.env.CODEX_HOME || join(homedir(), ".codex"),
): { models: { id: string; label: string }[]; reasoning: ReasoningLevel[] } | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as { models?: unknown[] } | unknown[];
    const list = (Array.isArray(raw) ? raw : (raw.models ?? [])) as {
      slug?: string;
      id?: string;
      display_name?: string;
      visibility?: string;
      supported_reasoning_levels?: ({ effort?: string } | string)[];
    }[];
    const models = list
      .filter(m => (m.slug || m.id) && m.visibility !== "hide")
      .map(m => ({ id: (m.slug || m.id)!, label: m.display_name || (m.slug || m.id)! }))
      .filter(m => !/review/i.test(m.id));
    if (!models.length) return null;
    const levels = new Set<ReasoningLevel>();
    for (const m of list.slice(0, 1))
      for (const r of m.supported_reasoning_levels ?? []) {
        const parsed = ReasoningLevel.safeParse(typeof r === "string" ? r : r.effort);
        if (parsed.success) levels.add(parsed.data);
      }
    return { models, reasoning: levels.size ? [...levels] : AGENT_CAPABILITIES.codex.reasoning };
  } catch {
    return null;
  }
}

export function capabilitiesFor(kind: AgentKind, opts: { agentVersion: string | null; model?: string; reasoning?: string }): RunnerCapabilities {
  const base = AGENT_CAPABILITIES[kind];
  const codex = kind === "codex" ? codexModels() : null;
  const reasoning = ReasoningLevel.safeParse(opts.reasoning);
  return {
    agent: kind,
    agentVersion: opts.agentVersion,
    models: codex?.models ?? base.models,
    reasoning: codex?.reasoning ?? base.reasoning,
    attachments: { ...base.attachments, maxImageBytes: MAX_IMAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, chunkBytes: ATTACHMENT_CHUNK_BYTES },
    compact: base.compact,
    model: opts.model ?? null,
    reasoningLevel: reasoning.success ? reasoning.data : null,
  };
}
