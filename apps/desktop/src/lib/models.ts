import { AGENT_CAPABILITIES, type AgentKind, type AgentModel, type ReasoningLevel } from "@lemonlime/protocol";
import { compareVersions, TESTED_AGENTS, type AgentInstall } from "./system.ts";

/**
 * The model picker and Settings → Agents → Harness: which agents to offer and in what
 * order, their models (with search), effort levels, and OpenCode's own model list.
 */

export const ALL_AGENTS: readonly AgentKind[] = ["claude-code", "codex", "opencode", "acp"];

/** Every agent once, in the user's order first, then the ones the order doesn't name yet. */
export function orderedAgents(order: readonly AgentKind[]): AgentKind[] {
  return [...new Set([...order.filter(a => ALL_AGENTS.includes(a)), ...ALL_AGENTS])];
}

/** The order with `kind` moved to place `to` (clamped), for dragging or the arrow keys. */
export function moveAgent(order: readonly AgentKind[], kind: AgentKind, to: number): AgentKind[] {
  const next = orderedAgents(order).filter(a => a !== kind);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, kind);
  return next;
}

/**
 * The agents the picker shows as tabs: the ones on this computer (every one outside the
 * desktop app, where nothing can be detected), ACP when there are saved ACP agents, none
 * the user hid, in the user's order. The agent in use is always there.
 */
export function pickerAgents(o: {
  order: readonly AgentKind[];
  hidden: readonly AgentKind[];
  installed: readonly AgentInstall[] | null;
  inShell: boolean;
  acpSaved: number;
  current: AgentKind;
}): AgentKind[] {
  const here = (k: AgentKind) => {
    if (k === "acp") return o.acpSaved > 0;
    if (!o.inShell || o.installed === null) return true;
    return o.installed.some(a => a.kind === k && a.installed);
  };
  return orderedAgents(o.order).filter(k => k === o.current || (here(k) && !o.hidden.includes(k)));
}

/** Search: every word typed must be in the model's name or id, ignoring case and separators. */
export function filterModels<T extends { id: string; label: string }>(models: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...models];
  const squash = (s: string) => s.toLowerCase().replace(/[\s._/-]+/g, "");
  return models.filter(m => {
    const hay = `${m.label} ${m.id}`.toLowerCase();
    const flat = squash(hay);
    return words.every(w => hay.includes(w) || flat.includes(squash(w)));
  });
}

/** The models shown first, and the ones under "More models". */
export function splitModels(models: readonly AgentModel[]): { main: AgentModel[]; older: AgentModel[] } {
  return { main: models.filter(m => !m.older), older: models.filter(m => m.older) };
}

/** A model's name for the picker; an unknown id is shown as it is. */
export function modelLabel(models: readonly AgentModel[], id: string | null | undefined): string | null {
  if (!id) return null;
  return models.find(m => m.id === id)?.label ?? id;
}

/** The effort levels to offer: the slowest ones only when Settings says so. */
export function effortLevels(kind: AgentKind, showMax: boolean): ReasoningLevel[] {
  const all = AGENT_CAPABILITIES[kind].reasoning;
  return showMax ? [...all] : all.filter(r => r !== "max" && r !== "ultra");
}

/** The next effort level after `current`, going round; the first one from none. */
export function cycleEffort(levels: readonly ReasoningLevel[], current: ReasoningLevel | null): ReasoningLevel | null {
  if (!levels.length) return null;
  const i = current ? levels.indexOf(current) : -1;
  return levels[(i + 1) % levels.length]!;
}

/**
 * Reads what `opencode models` prints: one `provider/model` per line, or, with
 * `--verbose`, each line followed by the model's details as JSON (name, context window).
 * Anything that isn't one of those is skipped.
 */
export function parseOpencodeModels(text: string): AgentModel[] {
  const out: AgentModel[] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const isId = (line: string) => /^[A-Za-z0-9][\w.@:-]*\/[^\s{}"]+$/.test(line);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!isId(line)) continue;
    // Its details, if a JSON object follows: everything up to the closing brace at the start of a line.
    let details: OpencodeDetails | null = null;
    const next = lines[i + 1]?.trim() ?? "";
    if (next.startsWith("{") && next.endsWith("}")) {
      try {
        details = JSON.parse(next) as OpencodeDetails;
      } catch {
        details = null;
      }
      i++;
    } else if (next === "{") {
      let end = i + 1;
      while (end < lines.length && lines[end] !== "}") end++;
      try {
        details = JSON.parse(lines.slice(i + 1, end + 1).join("\n")) as OpencodeDetails;
      } catch {
        details = null;
      }
      i = end;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    const provider = line.slice(0, line.indexOf("/"));
    const name = typeof details?.name === "string" && details.name.trim() ? details.name.trim() : line.slice(line.indexOf("/") + 1);
    const context = typeof details?.limit?.context === "number" ? contextNote(details.limit.context) : undefined;
    out.push({ id: line, label: `${providerName(provider)}/${name}`, ...(context ? { context } : {}) });
  }
  return out;
}

interface OpencodeDetails {
  name?: unknown;
  limit?: { context?: unknown };
}

/** "1M" for a window of a million tokens or more; nothing smaller is worth a note. */
function contextNote(tokens: number): string | undefined {
  return tokens >= 1_000_000 ? `${Math.floor(tokens / 1_000_000)}M` : undefined;
}

const PROVIDERS: Record<string, string> = { opencode: "OpenCode", anthropic: "Anthropic", openai: "OpenAI", google: "Google", openrouter: "OpenRouter" };
function providerName(id: string): string {
  return PROVIDERS[id] ?? id;
}

// ── Settings → Agents → Harness ──────────────────────────────

export type HarnessStatus = "ready" | "sign-in" | "update" | "unknown";

export interface HarnessRow {
  kind: Exclude<AgentKind, "acp">;
  installed: boolean;
  version: string | null;
  isDefault: boolean;
  hidden: boolean;
  /** Runs in cloud sandboxes too (they come with every agent LemonLime supports). */
  cloud: boolean;
  /** "unavailable": not installed with npm, so it updates itself (or is updated by hand). */
  autoUpdate: "on" | "off" | "unavailable";
  status: HarnessStatus;
}

/** "Update" when the installed CLI is older than the version LemonLime is tested with. */
export function needsUpdate(a: AgentInstall): boolean {
  const tested = TESTED_AGENTS.find(t => t.kind === a.kind);
  return Boolean(a.installed && a.version && tested && compareVersions(a.version, tested.version) < 0);
}

/** The Harness table: installed agents in the user's order, then the ones that aren't. */
export function harnessRows(o: {
  agents: readonly AgentInstall[] | null;
  order: readonly AgentKind[];
  hidden: readonly AgentKind[];
  defaultAgent: AgentKind;
  autoUpdate: readonly AgentKind[];
}): { installed: HarnessRow[]; notInstalled: HarnessRow[] } {
  const rows = orderedAgents(o.order)
    .filter((k): k is HarnessRow["kind"] => k !== "acp")
    .map<HarnessRow>(kind => {
      const a = o.agents?.find(x => x.kind === kind);
      const installed = Boolean(a?.installed);
      return {
        kind,
        installed,
        version: a?.version ?? null,
        isDefault: o.defaultAgent === kind,
        hidden: o.hidden.includes(kind),
        cloud: true,
        autoUpdate: installed && a?.viaNpm ? (o.autoUpdate.includes(kind) ? "on" : "off") : "unavailable",
        status: !a || !installed ? "unknown" : needsUpdate(a) ? "update" : a.signedIn === false ? "sign-in" : a.signedIn === null ? "unknown" : "ready",
      };
    });
  return { installed: rows.filter(r => r.installed), notInstalled: rows.filter(r => !r.installed) };
}

/** Agents to update on launch: switched on, installed with npm, and older than the tested version. */
export function agentsToAutoUpdate(agents: readonly AgentInstall[], autoUpdate: readonly AgentKind[]): AgentInstall["kind"][] {
  return agents.filter(a => autoUpdate.includes(a.kind) && a.viaNpm && needsUpdate(a)).map(a => a.kind);
}
