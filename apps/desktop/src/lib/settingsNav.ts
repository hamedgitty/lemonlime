import type { AgentKind } from "@lemonlime/protocol";

/**
 * Opening Settings → Agents at one of its tabs from anywhere (the model picker's "+",
 * "Accounts…" in the Harness table). The tab waits here until the Agents page reads it;
 * a page already open hears the event.
 */

export type AgentsTab = "harness" | "accounts" | "defaults" | "guard" | "claude-code" | "codex" | "acp" | "retry";

export interface AgentsTabRequest {
  tab: AgentsTab;
  /** For Accounts: the agent to show. */
  agent?: AgentKind;
}

let pending: AgentsTabRequest | null = null;

export const AGENTS_TAB_EVENT = "lemonlime:agents-tab";
export const OPEN_SETTINGS_EVENT = "lemonlime:open-settings";

/** Ask for an Agents tab; the page shows it now if it's open, or when it opens. */
export function requestAgentsTab(req: AgentsTabRequest): void {
  pending = req;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<AgentsTabRequest>(AGENTS_TAB_EVENT, { detail: req }));
}

/** The tab asked for, once (then it's forgotten). */
export function takeAgentsTab(): AgentsTabRequest | null {
  const p = pending;
  pending = null;
  return p;
}

/** Open Settings → Agents at a tab, from a place that can't reach the app's navigation. */
export function openAgentsSettings(req: AgentsTabRequest): void {
  requestAgentsTab(req);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "agents" }));
}
