import { useEffect, useState } from "react";
import { ACCOUNT_AGENTS, type AccountAgent, type AccountsList, type AgentAccount, type UsageWindow } from "@lemonlime/protocol";
import { lastAccounts, listAccounts } from "./accounts.ts";

/**
 * The sidebar's usage card: for each signed-in agent, the plan limits its account in use
 * reported (5-hour and 7-day), from the same list Settings → Agents → Accounts shows.
 */

export interface UsageRow {
  agent: AccountAgent;
  /** Whose limits these are, when more than one account of the agent is signed in. */
  account?: string;
  windows: UsageWindow[];
  observedAt: string;
}

const WINDOW_ORDER: Record<UsageWindow["kind"], number> = { five_hour: 0, seven_day: 1, other: 2 };

/** One row per agent with usage to show; none when no agent reports any. */
export function usageRows(list: AccountsList | null): UsageRow[] {
  if (!list) return [];
  const rows: UsageRow[] = [];
  for (const agent of ACCOUNT_AGENTS) {
    const accounts = list.agents[agent] ?? [];
    const signedIn = accounts.filter(a => a.signedIn === true);
    // The account new threads use; else the first signed-in one that reported.
    const pick: AgentAccount | undefined = signedIn.find(a => a.isDefault && a.usage?.windows.length) ?? signedIn.find(a => a.usage?.windows.length);
    if (!pick?.usage) continue;
    // The 5h and 7d bars; another window only when the agent reports neither.
    const main = pick.usage.windows.filter(w => w.kind !== "other");
    const windows = (main.length ? main : pick.usage.windows.slice(0, 2)).slice().sort((a, b) => WINDOW_ORDER[a.kind] - WINDOW_ORDER[b.kind]);
    rows.push({
      agent,
      ...(signedIn.length > 1 ? { account: pick.email ?? pick.label } : {}),
      windows,
      observedAt: pick.usage.observedAt,
    });
  }
  return rows;
}

/** The bar's colour band, shared by the sidebar and Settings. */
export function usageTone(percent: number): "ok" | "high" | "full" {
  return percent >= 90 ? "full" : percent >= 70 ? "high" : "ok";
}

/** Refresh when the window comes back to the front, at most this often. */
export const USAGE_REFRESH_MS = 2 * 60_000;

/** Whether it's time to ask the agents again. */
export function dueForRefresh(lastAt: number | null, now: number, every = USAGE_REFRESH_MS): boolean {
  return lastAt === null || now - lastAt >= every;
}

let lastFetchAt: number | null = null;

/**
 * The accounts list for the usage card: the last one seen at once, then asked again on
 * start and whenever the window gains focus (at most every two minutes).
 */
export function useAgentUsage(enabled: boolean): UsageRow[] {
  const [list, setList] = useState<AccountsList | null>(() => (enabled ? lastAccounts() : null));
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () => {
      const now = Date.now();
      if (!dueForRefresh(lastFetchAt, now)) {
        setList(l => lastAccounts() ?? l);
        return;
      }
      lastFetchAt = now;
      void listAccounts()
        .then(l => live && l && setList(l))
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [enabled]);
  return usageRows(list);
}
