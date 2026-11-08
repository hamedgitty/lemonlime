import { useEffect, useState } from "react";
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

/**
 * Jumping to one setting (Settings search): the page's tab to show and the row to bring into
 * view. Pages read their tab with `useSettingsTab`; Settings scrolls to the row and tints it.
 */
const pendingTabs = new Map<string, string>();
let pendingTarget: { page: string; anchor: string } | null = null;

export const SETTINGS_TAB_EVENT = "lemonlime:settings-tab";
export const SETTING_TARGET_EVENT = "lemonlime:setting-target";

export function requestSettingsTab(page: string, tab: string): void {
  if (page === "agents") return requestAgentsTab({ tab: tab as AgentsTab });
  pendingTabs.set(page, tab);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SETTINGS_TAB_EVENT, { detail: { page, tab } }));
}

export function takeSettingsTab(page: string): string | null {
  const t = pendingTabs.get(page) ?? null;
  pendingTabs.delete(page);
  return t;
}

/** A page's tab, which a jump from Settings search can change. */
export function useSettingsTab<T extends string>(page: string, initial: T, allowed: readonly T[]): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => {
    const asked = takeSettingsTab(page);
    return asked && (allowed as readonly string[]).includes(asked) ? (asked as T) : initial;
  });
  const allowedKey = allowed.join(",");
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ page: string; tab: string }>).detail;
      if (d.page !== page || !allowedKey.split(",").includes(d.tab)) return;
      takeSettingsTab(page);
      setTab(d.tab as T);
    };
    window.addEventListener(SETTINGS_TAB_EVENT, on);
    return () => window.removeEventListener(SETTINGS_TAB_EVENT, on);
  }, [page, allowedKey]);
  return [tab, setTab];
}

/** Bring a setting's row into view once its page shows it. */
export function requestSettingTarget(page: string, anchor: string): void {
  pendingTarget = { page, anchor };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SETTING_TARGET_EVENT));
}

/** The row waiting to be shown on `page`, once (then it's forgotten). */
export function takeSettingTarget(page: string): string | null {
  if (!pendingTarget || pendingTarget.page !== page) return null;
  const t = pendingTarget.anchor;
  pendingTarget = null;
  return t;
}
