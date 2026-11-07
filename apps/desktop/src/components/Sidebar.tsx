import type { ReactNode } from "react";
import { Cloud, Laptop, Plus, RefreshCw, Settings as SettingsIcon } from "lucide-react";
import type { ThreadSummary } from "../lib/threads.ts";
import { AGENT_LABELS, STATUS_LABELS, relativeTime, repoName } from "../lib/format.ts";
import { LogoMark, Spinner, StatusDot, cx } from "./ui.tsx";

export interface SidebarProps {
  local: ThreadSummary[];
  cloud: ThreadSummary[];
  cloudConfigured: boolean;
  cloudLoading: boolean;
  cloudError: string | null;
  selectedId: string | null;
  settingsOpen: boolean;
  onSelect: (t: ThreadSummary) => void;
  onNew: () => void;
  onSettings: () => void;
  onRefreshCloud: () => void;
}

export function Sidebar(p: SidebarProps) {
  return (
    <nav aria-label="Threads" className="on-rind flex w-[284px] shrink-0 flex-col bg-rind text-rind-text">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <LogoMark size={24} />
        <span className="font-display text-[19px] font-semibold tracking-tight text-white">LemonLime</span>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={p.onNew}
          className="flex h-9.5 w-full items-center justify-center gap-2 rounded-[10px] bg-lemon text-sm font-semibold text-ink shadow-[inset_0_-1px_0_rgb(0_0_0/0.12)] transition-colors hover:bg-[#ffe84f]"
        >
          <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />
          New thread
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Section icon={<Laptop aria-hidden="true" className="size-3.5" />} title="On this computer">
          {p.local.length === 0 ? (
            <p className="px-2.5 py-2 text-[13px] text-rind-muted">No local threads yet.</p>
          ) : (
            p.local.map(t => <ThreadRow key={t.id} t={t} selected={t.id === p.selectedId} onSelect={p.onSelect} />)
          )}
        </Section>

        <Section
          icon={<Cloud aria-hidden="true" className="size-3.5" />}
          title="Cloud"
          action={
            p.cloudConfigured ? (
              <button
                type="button"
                onClick={p.onRefreshCloud}
                aria-label="Refresh cloud threads"
                title="Refresh"
                className="inline-flex size-6 items-center justify-center rounded-md text-rind-muted hover:bg-white/5 hover:text-rind-text"
              >
                {p.cloudLoading ? <Spinner className="size-3" /> : <RefreshCw aria-hidden="true" className="size-3.5" />}
              </button>
            ) : null
          }
        >
          {!p.cloudConfigured ? (
            <p className="px-2.5 py-2 text-[13px] leading-snug text-rind-muted">
              Connect a control plane in{" "}
              <button type="button" onClick={p.onSettings} className="text-lime underline-offset-2 hover:underline">
                Settings
              </button>{" "}
              to run threads in cloud sandboxes.
            </p>
          ) : p.cloudError ? (
            <p className="px-2.5 py-2 text-[13px] leading-snug text-[#f5a3a3]">{p.cloudError}</p>
          ) : p.cloud.length === 0 ? (
            <p className="px-2.5 py-2 text-[13px] text-rind-muted">{p.cloudLoading ? "Loading…" : "No cloud threads yet."}</p>
          ) : (
            p.cloud.map(t => <ThreadRow key={t.id} t={t} selected={t.id === p.selectedId} onSelect={p.onSelect} />)
          )}
        </Section>
      </div>

      <div className="border-t border-rind-line p-2">
        <button
          type="button"
          onClick={p.onSettings}
          aria-current={p.settingsOpen ? "page" : undefined}
          className={cx(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
            p.settingsOpen ? "bg-rind-raised text-white" : "text-rind-muted hover:bg-white/5 hover:text-rind-text",
          )}
        >
          <SettingsIcon aria-hidden="true" className="size-4" />
          Settings
        </button>
      </div>
    </nav>
  );
}

function Section({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="flex h-8 items-center gap-2 px-2.5 text-[12.5px] font-medium text-rind-muted">
        {icon}
        <h2 className="flex-1 font-sans text-[12.5px] font-medium tracking-normal">{title}</h2>
        {action}
      </div>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function ThreadRow({ t, selected, onSelect }: { t: ThreadSummary; selected: boolean; onSelect: (t: ThreadSummary) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(t)}
        aria-current={selected ? "page" : undefined}
        className={cx(
          "group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
          selected ? "bg-rind-raised shadow-[inset_2px_0_0_var(--color-lime)]" : "hover:bg-white/[0.04]",
        )}
      >
        <StatusDot status={t.status} className="mt-[7px]" />
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-[13.5px] font-medium", selected ? "text-white" : "text-rind-text")}>{t.title}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-rind-muted">
            <span className="truncate">{repoName(t.repo)}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{AGENT_LABELS[t.agent.kind]}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{relativeTime(t.updatedAt)}</span>
          </span>
          <span className="sr-only">Status: {STATUS_LABELS[t.status]}</span>
        </span>
      </button>
    </li>
  );
}
