import type { UsageRow } from "../lib/agentUsage.ts";
import { AGENT_LABELS } from "../lib/format.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { UsageBar } from "./UsageBar.tsx";
import { resetText } from "./settings/AccountsTab.tsx";
import { openExternal } from "./ui.tsx";

/** What the deployment says about cloud use (hours left and the like). */
export interface CloudSummary {
  title: string;
  detail: string;
  progress?: number;
  actionUrl?: string;
  actionLabel?: string;
}

/**
 * The one card above the sidebar's footer: cloud use from the deployment, if it reports
 * any, and each signed-in agent's plan limits. Nothing shows when neither has anything.
 */
export function SidebarUsageCard({ cloud, agents, onOpenAccounts }: { cloud?: CloudSummary | null; agents: UsageRow[]; onOpenAccounts: () => void }) {
  if (!cloud && agents.length === 0) return null;
  return (
    <div className="rounded-xl border border-line bg-paper">
      {cloud && (
        <div className="px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{cloud.title}</p>
            {cloud.actionUrl && (
              <button type="button" onClick={() => void openExternal(cloud.actionUrl!)} className="shrink-0 text-[12px] font-medium text-leaf hover:underline">
                {cloud.actionLabel ?? "Manage"}
              </button>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-ink-soft">{cloud.detail}</p>
          {cloud.progress !== undefined && <UsageBar percent={cloud.progress * 100} label={cloud.title} className="mt-2" />}
        </div>
      )}
      {cloud && agents.length > 0 && <div aria-hidden="true" className="mx-3 h-px bg-line" />}
      {agents.length > 0 && (
        <button
          type="button"
          onClick={onOpenAccounts}
          aria-label="Plan usage. Open agent accounts"
          className="flex w-full flex-col gap-2 rounded-xl px-3 py-2.5 text-left transition-colors duration-100 hover:bg-cream-deep"
        >
          {agents.map(row => (
            <div key={row.agent} className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <AgentIcon kind={row.agent} className="size-3.5 text-ink-soft" />
                <span className="shrink-0 font-medium text-ink">{AGENT_LABELS[row.agent]}</span>
                {row.account && (
                  <span className="min-w-0 truncate text-ink-faint" title={row.account}>
                    {row.account}
                  </span>
                )}
              </span>
              <span className="grid grid-cols-2 gap-3">
                {row.windows.map(w => {
                  const pct = Math.round(w.usedPercent);
                  const resets = w.resetsAt ? resetText(w.resetsAt) : "";
                  return (
                    <span key={`${w.kind}:${w.label}`} className="flex min-w-0 items-center gap-1.5 text-[12px]" title={resets || undefined}>
                      <span className="shrink-0 text-ink-faint">{w.label}</span>
                      <UsageBar
                        percent={pct}
                        label={`${AGENT_LABELS[row.agent]} ${w.label} limit used${resets ? `, ${resets.toLowerCase()}` : ""}`}
                        className="min-w-0 flex-1"
                      />
                      <span className="w-8 shrink-0 text-right text-ink-soft tabular-nums">{pct}%</span>
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
        </button>
      )}
    </div>
  );
}
