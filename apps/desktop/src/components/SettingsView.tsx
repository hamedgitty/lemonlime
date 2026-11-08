import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Blocks,
  Cloud,
  FolderGit2,
  Keyboard,
  NotebookPen,
  Package,
  Palette,
  Search,
  Server,
  Settings as SettingsIcon,
  UserRound,
} from "lucide-react";
import { Kbd } from "./primitives.tsx";
import { cx } from "./ui.tsx";
import { AccountPage } from "./settings/AccountPage.tsx";
import { AgentsPage } from "./settings/AgentsPage.tsx";
import { AppearancePage } from "./settings/AppearancePage.tsx";
import { CloudPage } from "./settings/CloudPage.tsx";
import type { SettingsCtx } from "./settings/context.ts";
import { GeneralPage } from "./settings/GeneralPage.tsx";
import { InstructionsPage } from "./settings/InstructionsPage.tsx";
import { KeyboardPage } from "./settings/KeyboardPage.tsx";
import { MachinesPage } from "./settings/MachinesPage.tsx";
import { ProjectsPage } from "./settings/ProjectsPage.tsx";
import { UpdatesPage } from "./settings/UpdatesPage.tsx";

export type { SettingsCtx } from "./settings/context.ts";

export type SettingsPage = "account" | "general" | "agents" | "instructions" | "cloud" | "machines" | "projects" | "appearance" | "keyboard" | "updates";

export const SETTINGS_PAGES: { id: SettingsPage; label: string; icon: typeof UserRound; keywords: string }[] = [
  { id: "account", label: "Account", icon: UserRound, keywords: "cloud control plane url token sign in sign out connect github workspace activity usage" },
  {
    id: "general",
    label: "General",
    icon: SettingsIcon,
    keywords:
      "runner path follow up queue steer enter open new threads notifications notify test keep awake sleep screen files editor vs code cursor zed phone mobile remote",
  },
  {
    id: "agents",
    label: "Agents",
    icon: Blocks,
    keywords:
      "claude codex opencode acp harness version install update auto-update sign in sign out default agent accounts order model effort fast mode co-author coauthor branch prefix reasoning command guard retry limit overloaded",
  },
  { id: "instructions", label: "Instructions", icon: NotebookPen, keywords: "custom instructions system prompt built-in skills" },
  { id: "cloud", label: "Cloud", icon: Cloud, keywords: "setup script environment api keys secrets skills sync auto delete clean up sandbox" },
  {
    id: "machines",
    label: "Machines",
    icon: Server,
    keywords: "ssh remote server home server dev box tailscale another computer machine host runner",
  },
  { id: "projects", label: "Projects", icon: FolderGit2, keywords: "projects folders repositories archived restore import export chats markdown json" },
  { id: "appearance", label: "Appearance", icon: Palette, keywords: "theme dark light system sidebar organize sort agent icons fold collapse turns" },
  { id: "keyboard", label: "Keyboard", icon: Keyboard, keywords: "shortcuts keys rebind" },
  { id: "updates", label: "Updates", icon: Package, keywords: "version release changelog community github website docs report" },
];

/** The sidebar while Settings is open: back to the app, search, and the sections. */
export function SettingsSidebar({ page, onPage, onBack }: { page: SettingsPage; onPage: (p: SettingsPage) => void; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? SETTINGS_PAGES.filter(p => `${p.label} ${p.keywords}`.toLowerCase().includes(q)) : SETTINGS_PAGES;
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Escape" && !typing) {
        e.preventDefault();
        onBack();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <nav aria-label="Settings" className="flex w-[288px] shrink-0 flex-col border-r border-line bg-cream-deep">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-[14px] font-medium hover:bg-cream-hover"
        >
          <ArrowLeft aria-hidden="true" className="size-4 text-leaf" />
          <span className="flex-1 text-left">Back to app</span>
          <Kbd>Esc</Kbd>
        </button>
      </div>
      <div className="mx-3 my-3 h-px bg-line" />
      <div className="px-2">
        <label className="flex h-[34px] items-center gap-2 rounded-lg border border-line-strong bg-paper px-2.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-leaf">
          <Search aria-hidden="true" className="size-3.5 text-ink-faint" />
          <input
            ref={search}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && visible[0]) onPage(visible[0].id);
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint"
          />
          <Kbd>/</Kbd>
        </label>
      </div>
      <ul className="mt-3 flex flex-col gap-px px-2">
        {visible.map(p => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPage(p.id)}
              aria-current={page === p.id ? "page" : undefined}
              className={cx(
                "flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14px] hover:bg-cream-hover",
                page === p.id && "bg-cream-hover",
              )}
            >
              <p.icon aria-hidden="true" className="size-4 text-ink-soft" />
              {p.label}
            </button>
          </li>
        ))}
        {visible.length === 0 && <li className="px-2 py-1.5 text-[13.5px] text-ink-faint">Nothing matches "{query}"</li>}
      </ul>
    </nav>
  );
}

export function SettingsView({ page, ctx, importTab }: { page: SettingsPage; ctx: SettingsCtx; importTab?: ReactNode }) {
  const current = SETTINGS_PAGES.find(p => p.id === page) ?? SETTINGS_PAGES[0]!;
  return (
    <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <header data-tauri-drag-region className="flex h-[52px] items-center border-b border-line px-6">
        <h1 className="font-sans text-[15px] font-semibold tracking-normal">Settings</h1>
      </header>
      <div className="mx-auto w-full max-w-[880px] px-6 pt-7 pb-16">
        <h2 className="mb-5 flex items-center gap-2.5 text-[22px] font-semibold">
          <current.icon aria-hidden="true" className="size-5 text-ink-soft" />
          {current.label}
        </h2>
        {current.id === "account" && <AccountPage ctx={ctx} />}
        {current.id === "general" && <GeneralPage ctx={ctx} />}
        {current.id === "agents" && <AgentsPage ctx={ctx} />}
        {current.id === "instructions" && <InstructionsPage ctx={ctx} />}
        {current.id === "cloud" && <CloudPage ctx={ctx} />}
        {current.id === "machines" && <MachinesPage ctx={ctx} />}
        {current.id === "projects" && <ProjectsPage ctx={ctx} {...(importTab ? { importTab } : {})} />}
        {current.id === "appearance" && <AppearancePage ctx={ctx} />}
        {current.id === "keyboard" && <KeyboardPage ctx={ctx} />}
        {current.id === "updates" && <UpdatesPage ctx={ctx} />}
      </div>
    </main>
  );
}
