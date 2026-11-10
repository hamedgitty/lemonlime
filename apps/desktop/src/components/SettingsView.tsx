import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Blocks,
  Cloud,
  FolderGit2,
  Keyboard,
  NotebookPen,
  Package,
  Palette,
  PanelLeft,
  Search,
  Server,
  Settings as SettingsIcon,
  UserRound,
} from "lucide-react";
import { settingAnchor, groupByPage, findSettings, type SettingEntry } from "../lib/settingsIndex.ts";
import { requestSettingsTab, requestSettingTarget, SETTING_TARGET_EVENT, takeSettingTarget } from "../lib/settingsNav.ts";
import { Kbd } from "./primitives.tsx";
import { IconButton, cx } from "./ui.tsx";
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
import { composing } from "../lib/ime.ts";

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
  { id: "appearance", label: "Appearance", icon: Palette, keywords: "theme dark light mode sidebar organize sort agent icons fold collapse turns" },
  { id: "keyboard", label: "Keyboard", icon: Keyboard, keywords: "shortcuts keys rebind" },
  { id: "updates", label: "Updates", icon: Package, keywords: "version release changelog community github website docs report" },
];

type Result = { kind: "page"; page: (typeof SETTINGS_PAGES)[number] } | { kind: "entry"; entry: SettingEntry; page: (typeof SETTINGS_PAGES)[number] };

/** What a search finds: matching options grouped under their page, and pages that match by name. */
function searchResults(query: string): Result[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const groups = groupByPage(
    findSettings(q),
    SETTINGS_PAGES.map(p => p.id),
  );
  const out: Result[] = [];
  for (const p of SETTINGS_PAGES) {
    const entries = groups.find(gr => gr.page === p.id)?.entries ?? [];
    const pageHit = q.split(/\s+/).every(w => `${p.label} ${p.keywords}`.toLowerCase().includes(w));
    if (!entries.length && !pageHit) continue;
    out.push({ kind: "page", page: p });
    for (const entry of entries) out.push({ kind: "entry", entry, page: p });
  }
  return out;
}

/** The sidebar while Settings is open: back to the app, search, and the sections. */
export function SettingsSidebar({
  page,
  onPage,
  onBack,
  onHide,
}: {
  page: SettingsPage;
  onPage: (p: SettingsPage) => void;
  onBack: () => void;
  onHide: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => searchResults(query), [query]);
  // Start on the first matching option; a page heading only when no option matches.
  useEffect(
    () =>
      setActive(
        Math.max(
          0,
          results.findIndex(r => r.kind === "entry"),
        ),
      ),
    [results],
  );
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));

  const pick = (r: Result) => {
    if (r.kind === "entry") {
      if (r.entry.tab) requestSettingsTab(r.entry.page, r.entry.tab);
      requestSettingTarget(r.entry.page, settingAnchor(r.entry));
    }
    onPage(r.page.id);
  };

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

  const searching = query.trim().length > 0;
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <nav aria-label="Settings" className="flex w-full flex-col border-r border-line bg-cream-deep">
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end px-2">
        <IconButton label="Hide sidebar" onClick={onHide}>
          <PanelLeft aria-hidden="true" />
        </IconButton>
      </div>
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
              if (composing(e)) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (!results.length) return;
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                const next = (activeIndex + step + results.length) % results.length;
                setActive(next);
                // Keep the highlighted row in sight when the list is longer than its box.
                document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
              }
              if (e.key === "Enter" && results[activeIndex]) {
                e.preventDefault();
                pick(results[activeIndex]!);
              }
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search settings…"
            aria-label="Search settings"
            role="combobox"
            aria-expanded={searching}
            aria-controls={searching ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={searching && results.length ? optionId(activeIndex) : undefined}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint"
          />
          <Kbd>/</Kbd>
        </label>
      </div>
      {searching ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Matching settings"
          className="scroll-thin mt-3 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-3"
        >
          {results.map((r, i) => {
            const selected = i === activeIndex;
            return (
              <div
                key={r.kind === "page" ? r.page.id : `${r.entry.page}:${r.entry.tab ?? ""}:${r.entry.title}`}
                id={optionId(i)}
                role="option"
                aria-selected={selected}
                onMouseDown={e => e.preventDefault()}
                // Only a pointer that really moved: the list sliding under a still one doesn't count.
                onMouseMove={e => (e.movementX || e.movementY) && !selected && setActive(i)}
                onClick={() => pick(r)}
                className={cx(
                  "flex min-h-[30px] cursor-default items-center gap-2.5 rounded-lg px-2 text-[14px]",
                  r.kind === "page" && i > 0 && "mt-2",
                  selected && "bg-cream-hover",
                )}
              >
                {r.kind === "page" ? (
                  <>
                    <r.page.icon aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
                    <span className="font-medium">{r.page.label}</span>
                  </>
                ) : (
                  <span className="min-w-0 flex-1 py-1 pl-[26px] leading-snug text-ink-soft">{r.entry.title}</span>
                )}
              </div>
            );
          })}
          {results.length === 0 && <p className="px-2 py-1.5 text-[14px] text-ink-faint">Nothing matches “{query.trim()}”</p>}
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-px px-2">
          {SETTINGS_PAGES.map(p => (
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
        </ul>
      )}
    </nav>
  );
}

/** Brings the row Settings search asked for into view and tints it, once the page shows it. */
function useJumpToSetting(page: string, root: React.RefObject<HTMLElement | null>) {
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    let frame = 0;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const anchor = takeSettingTarget(pageRef.current);
      if (!anchor) return;
      cancelAnimationFrame(frame);
      let tries = 0;
      // The tab, or what's on it, may still be loading: look again for a little while.
      const look = () => {
        const el = root.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(anchor)}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.remove("setting-hit");
          void el.offsetWidth;
          el.classList.add("setting-hit");
          clearTimeout(clear);
          clear = setTimeout(() => el.classList.remove("setting-hit"), 1700);
          return;
        }
        if (++tries < 60) frame = requestAnimationFrame(look);
      };
      look();
    };
    reveal();
    const onTarget = () => requestAnimationFrame(reveal);
    window.addEventListener(SETTING_TARGET_EVENT, onTarget);
    return () => {
      window.removeEventListener(SETTING_TARGET_EVENT, onTarget);
      cancelAnimationFrame(frame);
      clearTimeout(clear);
    };
  }, [page, root]);
}

export function SettingsView({ page, ctx, importTab }: { page: SettingsPage; ctx: SettingsCtx; importTab?: ReactNode }) {
  const current = SETTINGS_PAGES.find(p => p.id === page) ?? SETTINGS_PAGES[0]!;
  const root = useRef<HTMLElement>(null);
  useJumpToSetting(current.id, root);
  return (
    <main ref={root} className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      {/* One heading: the page's name in the title bar; its tabs sit right under it. */}
      <header data-tauri-drag-region className="h-[52px] border-b border-line pl-[max(0px,calc(var(--chrome-inset,0px)-1.5rem))]">
        <div data-tauri-drag-region className="mx-auto flex h-full w-full max-w-[880px] items-center gap-2.5 px-6">
          <current.icon aria-hidden="true" className="size-4 text-ink-soft" />
          <h1 className="font-sans text-[15px] font-semibold tracking-normal">{current.label}</h1>
        </div>
      </header>
      <div className="mx-auto w-full max-w-[880px] px-6 pt-5 pb-16">
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
