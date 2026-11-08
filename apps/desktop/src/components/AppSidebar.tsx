import { useMemo, useState, type ReactNode } from "react";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  BookOpen,
  Download,
  FolderPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Ellipsis,
  FolderGit2,
  GripVertical,
  Laptop,
  Layers,
  MessageSquare,
  PanelLeft,
  Pin,
  PinOff,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  SquareTerminal,
  SquarePen,
  UserRound,
  X,
} from "lucide-react";
import type { ThreadSummary } from "../lib/threads.ts";
import { AGENT_LABELS, STATUS_LABELS, relativeTime, repoName } from "../lib/format.ts";
import { NAV_ITEMS, type NavItem, type UiPrefs } from "../lib/storage.ts";
import { Kbd, Menu, MenuChoice, MenuItem, MenuSeparator, SubMenu, Tip } from "./primitives.tsx";
import { LogoMark, Spinner, StatusDot, cx } from "./ui.tsx";

export interface AppSidebarProps {
  threads: ThreadSummary[];
  cloudConfigured: boolean;
  cloudLoading: boolean;
  cloudError: string | null;
  selectedId: string | null;
  prefs: UiPrefs;
  onPrefs: (patch: Partial<UiPrefs>) => void;
  onSelect: (t: ThreadSummary) => void;
  onNew: () => void;
  onAutomations: () => void;
  onSkills: () => void;
  /** Shows or hides the side panel (terminals on this computer, a browser). */
  onPanel: () => void;
  panelOpen: boolean;
  onPlugins: () => void;
  /** Pick a folder to start threads in. */
  onNewProject: () => void;
  /** Agent CLIs on this computer older than LemonLime is tested with (labels). */
  agentUpdates?: string[];
  onSettings: (page?: string) => void;
  onBack: (() => void) | null;
  onForward: (() => void) | null;
  /** Card above the footer, e.g. cloud hours left (from the deployment). */
  usageCard?: ReactNode;
  onArchive: (t: ThreadSummary, archive: boolean) => void;
  /** Shows traffic lights' room in the capsule (macOS app window). */
  macChrome: boolean;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
}

const NAV: Record<NavItem, { label: string; icon: typeof SquarePen; shortcut: string }> = {
  new: { label: "New thread", icon: SquarePen, shortcut: "⌘ N" },
  search: { label: "Search threads", icon: Search, shortcut: "⌘ K" },
  skills: { label: "Skills", icon: BookOpen, shortcut: "" },
  plugins: { label: "Plugins", icon: Puzzle, shortcut: "" },
  automations: { label: "Automations", icon: AlarmClock, shortcut: "" },
};

const ROW = "flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14px] text-ink transition-colors duration-100 hover:bg-cream-hover";

export function AppSidebar(p: AppSidebarProps) {
  const [customizing, setCustomizing] = useState(false);
  const [query, setQuery] = useState("");
  const [threadsOpen, setThreadsOpen] = useState(true);
  // Items added since the order was saved go at the end.
  const order = [...p.prefs.navOrder, ...NAV_ITEMS.filter(i => !p.prefs.navOrder.includes(i))];
  const visibleNav = order.filter(i => !p.prefs.hiddenNav.includes(i));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? p.threads.filter(t => `${t.title} ${repoName(t.repo)} ${t.branch} ${AGENT_LABELS[t.agent.kind]}`.toLowerCase().includes(q)) : p.threads;
    return p.prefs.sort === "name" ? [...list].sort((a, b) => a.title.localeCompare(b.title)) : list;
  }, [p.threads, query, p.prefs.sort]);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const archived = useMemo(() => filtered.filter(t => p.prefs.archived[t.id]), [filtered, p.prefs.archived]);
  const groups = useMemo(
    () =>
      groupThreads(
        filtered.filter(t => !p.prefs.archived[t.id]),
        p.prefs,
      ),
    [filtered, p.prefs],
  );

  const navAction = (item: NavItem) => {
    if (item === "new") p.onNew();
    else if (item === "automations") p.onAutomations();
    else if (item === "skills") p.onSkills();
    else if (item === "plugins") p.onPlugins();
    else p.onSearchOpen(!p.searchOpen);
  };

  return (
    <nav aria-label="LemonLime" className="flex w-[288px] shrink-0 flex-col border-r border-line bg-cream-deep">
      {/* Window controls: room for the traffic lights, then sidebar and history buttons. */}
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center px-2">
        <div data-tauri-drag-region className="flex h-9 items-center gap-0.5 rounded-full border border-line bg-cream/70 pr-1.5 pl-1">
          {p.macChrome ? (
            <span data-tauri-drag-region className="w-[62px]" />
          ) : (
            <span className="flex w-9 justify-center">
              <LogoMark size={20} />
            </span>
          )}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
          <ChromeButton label="Hide sidebar" onClick={() => p.onPrefs({ sidebarCollapsed: true })}>
            <PanelLeft />
          </ChromeButton>
          <ChromeButton label="Back" onClick={p.onBack ?? undefined} disabled={!p.onBack}>
            <ChevronLeft />
          </ChromeButton>
          <ChromeButton label="Forward" onClick={p.onForward ?? undefined} disabled={!p.onForward}>
            <ChevronRight />
          </ChromeButton>
        </div>
      </div>

      <div className="px-2 pt-2">
        {customizing ? (
          <CustomizeNav prefs={p.prefs} onPrefs={p.onPrefs} onDone={() => setCustomizing(false)} />
        ) : (
          <ul className="flex flex-col gap-px">
            {visibleNav.map(item => {
              const { label, icon: Icon, shortcut } = NAV[item];
              return (
                <li key={item}>
                  <button
                    type="button"
                    className={cx(ROW, item === "search" && p.searchOpen && "bg-cream-hover")}
                    onClick={() => navAction(item)}
                    aria-keyshortcuts={shortcut.replace(" ", "+").replace("⌘", "Meta")}
                  >
                    <Icon aria-hidden="true" className="size-4 text-ink-soft" />
                    <span className="flex-1">{label}</span>
                  </button>
                </li>
              );
            })}
            <li>
              <Menu
                side="right"
                align="start"
                sideOffset={10}
                trigger={
                  <button type="button" className={ROW}>
                    <Ellipsis aria-hidden="true" className="size-4 text-ink-soft" />
                    <span className="flex-1">More</span>
                  </button>
                }
              >
                <MenuItem icon={<Search />} onSelect={() => p.onSearchOpen(true)} hint="⌘K">
                  Search threads
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<SlidersHorizontal />} onSelect={() => setCustomizing(true)}>
                  Customize sidebar
                </MenuItem>
              </Menu>
            </li>
          </ul>
        )}
      </div>

      <div className="mx-3 my-4 h-px bg-line" />

      {p.searchOpen && (
        <div className="px-2 pb-2">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-paper px-2.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-leaf">
            <Search aria-hidden="true" className="size-3.5 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  setQuery("");
                  p.onSearchOpen(false);
                }
              }}
              placeholder="Search threads"
              aria-label="Search threads"
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint"
            />
            <button type="button" aria-label="Close search" onClick={() => (setQuery(""), p.onSearchOpen(false))} className="text-ink-faint hover:text-ink">
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </label>
        </div>
      )}

      {/* Threads */}
      <div className="group/threads flex h-8 items-center gap-1 px-2 pl-4">
        <button
          type="button"
          onClick={() => setThreadsOpen(o => !o)}
          aria-expanded={threadsOpen}
          className="flex flex-1 items-center gap-1 text-left text-[13.5px] text-ink-soft hover:text-ink"
        >
          Threads
          <ChevronDown
            aria-hidden="true"
            className={cx(
              "size-3.5 opacity-0 transition-[opacity,rotate] duration-150 group-hover/threads:opacity-100",
              !threadsOpen && "-rotate-90 opacity-100",
            )}
          />
        </button>
        {p.cloudLoading && <Spinner className="size-3 text-ink-faint" />}
        <Tip label="New thread">
          <button
            type="button"
            onClick={p.onNew}
            aria-label="New thread"
            className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft opacity-0 transition-opacity group-hover/threads:opacity-100 hover:bg-cream-hover focus-visible:opacity-100"
          >
            <SquarePen aria-hidden="true" className="size-3.5" />
          </button>
        </Tip>
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              aria-label="Thread list options"
              className="inline-flex size-7 items-center justify-center rounded-lg text-ink-soft opacity-0 transition-opacity group-hover/threads:opacity-100 hover:bg-cream-hover focus-visible:opacity-100 data-[popup-open]:bg-cream-hover data-[popup-open]:opacity-100"
            >
              <Ellipsis aria-hidden="true" className="size-4" />
            </button>
          }
        >
          <MenuItem icon={<FolderPlus />} onSelect={p.onNewProject}>
            New project…
          </MenuItem>
          <MenuSeparator />
          <SubMenu icon={<Layers />} label="Organize">
            <MenuChoice
              value={p.prefs.organize}
              onChange={organize => p.onPrefs({ organize })}
              options={[
                { value: "project", label: "By project" },
                { value: "place", label: "By where it runs" },
                { value: "agent", label: "By agent" },
              ]}
            />
          </SubMenu>
          <SubMenu icon={<ArrowDownUp />} label="Sort by">
            <MenuChoice
              value={p.prefs.sort}
              onChange={sort => p.onPrefs({ sort })}
              options={[
                { value: "recent", label: "Recent activity" },
                { value: "name", label: "Name" },
              ]}
            />
          </SubMenu>
        </Menu>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {threadsOpen &&
          (filtered.length === 0 ? (
            <p className="flex h-8 items-center gap-2.5 px-2 text-[14px] text-ink-faint">
              <MessageSquare aria-hidden="true" className="size-4" />
              {query ? "No threads match" : "No threads"}
            </p>
          ) : (
            groups.map(g => (
              <section key={g.key} aria-label={g.label} className="mb-2">
                {groups.length > 1 && (
                  <h3 className="flex h-7 items-center gap-2 px-2 font-sans text-[12.5px] font-medium tracking-normal text-ink-faint">
                    {g.icon}
                    <span className="truncate">{g.label}</span>
                  </h3>
                )}
                <ul className="flex flex-col gap-px">
                  {g.threads.map(t => (
                    <ThreadRow
                      key={`${t.mode}:${t.id}`}
                      t={t}
                      selected={t.id === p.selectedId}
                      pinned={p.prefs.pinned.includes(t.id)}
                      onSelect={p.onSelect}
                      agentIcon={p.prefs.agentIcons}
                      onPin={pin => p.onPrefs({ pinned: pin ? [t.id, ...p.prefs.pinned] : p.prefs.pinned.filter(id => id !== t.id) })}
                      archived={false}
                      onArchive={a => p.onArchive(t, a)}
                    />
                  ))}
                </ul>
              </section>
            ))
          ))}
        {threadsOpen && archived.length > 0 && (
          <section aria-label="Archived" className="mb-2">
            <button
              type="button"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen(o => !o)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] font-medium text-ink-faint hover:text-ink"
            >
              <Archive aria-hidden="true" className="size-3.5" />
              <span className="flex-1">Archived</span>
              <span className="tabular-nums">{archived.length}</span>
            </button>
            {archivedOpen && (
              <ul className="flex flex-col gap-px">
                {archived.map(t => (
                  <ThreadRow
                    key={`${t.mode}:${t.id}`}
                    t={t}
                    selected={t.id === p.selectedId}
                    pinned={false}
                    onSelect={p.onSelect}
                    onPin={() => undefined}
                    archived
                    onArchive={a => p.onArchive(t, a)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
        {p.cloudError && <p className="px-2 py-1 text-[13px] leading-snug text-danger">{p.cloudError}</p>}
      </div>

      {p.usageCard && <div className="px-2 pb-2">{p.usageCard}</div>}

      <div className="flex h-11 shrink-0 items-center gap-0.5 border-t border-line px-2">
        <Tip
          label={
            <>
              Settings <span className="font-normal opacity-75">⌘ ,</span>
            </>
          }
        >
          <button type="button" onClick={() => p.onSettings()} aria-label="Settings" className={FOOT}>
            <SettingsIcon aria-hidden="true" />
          </button>
        </Tip>
        <Tip label={p.cloudConfigured ? "Cloud account" : "Connect a cloud account"}>
          <button type="button" onClick={() => p.onSettings("account")} aria-label="Account" className={FOOT}>
            <UserRound aria-hidden="true" />
          </button>
        </Tip>
        <Tip
          label={
            <>
              Terminal and browser <span className="font-normal opacity-75">⌘ ⇧ \</span>
            </>
          }
        >
          <button
            type="button"
            onClick={p.onPanel}
            aria-label="Side panel"
            aria-pressed={p.panelOpen}
            className={cx(FOOT, p.panelOpen && "bg-cream-hover text-ink")}
          >
            <SquareTerminal aria-hidden="true" />
          </button>
        </Tip>
        <span className="flex-1" />
        {p.agentUpdates && p.agentUpdates.length > 0 && (
          <Tip label={`${p.agentUpdates.join(" and ")} ${p.agentUpdates.length === 1 ? "has" : "have"} an update`}>
            <button
              type="button"
              onClick={() => p.onSettings("agents")}
              aria-label="Agent updates"
              className="mr-1 inline-flex h-[26px] items-center gap-1.5 rounded-full border border-line bg-cream px-2 text-[12.5px] font-medium text-ink-soft hover:border-line-strong"
            >
              <Download aria-hidden="true" className="size-3.5 text-leaf" />
              {p.agentUpdates.length}
            </button>
          </Tip>
        )}
        <Tip
          label={
            p.cloudConfigured
              ? p.cloudError
                ? "Cloud: can't reach the control plane"
                : "Cloud threads are connected"
              : "Only threads on this computer. Connect a cloud account to run agents in the cloud."
          }
        >
          <button
            type="button"
            onClick={() => p.onSettings("account")}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-line bg-cream px-2.5 text-[12.5px] font-medium text-ink-soft hover:border-line-strong"
          >
            <span aria-hidden="true" className={cx("size-1.5 rounded-full", p.cloudConfigured ? (p.cloudError ? "bg-danger" : "bg-lime-2") : "bg-control")} />
            {p.cloudConfigured ? "Cloud" : "Local only"}
          </button>
        </Tip>
      </div>
    </nav>
  );
}

const FOOT = "inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-hover hover:text-ink [&_svg]:size-[17px]";

function ChromeButton({ label, onClick, disabled, children }: { label: string; onClick: (() => void) | undefined; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex size-7 items-center justify-center rounded-full text-ink-faint hover:bg-cream-hover hover:text-ink disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function ThreadRow({
  t,
  selected,
  pinned,
  onSelect,
  onPin,
  archived,
  onArchive,
  agentIcon = false,
}: {
  t: ThreadSummary;
  selected: boolean;
  agentIcon?: boolean;
  pinned: boolean;
  onSelect: (t: ThreadSummary) => void;
  onPin: (pin: boolean) => void;
  archived: boolean;
  onArchive: (archive: boolean) => void;
}) {
  const working = t.status === "running" || t.status === "provisioning";
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => onSelect(t)}
        aria-current={selected ? "page" : undefined}
        className={cx(
          "flex h-8 w-full items-center gap-2.5 rounded-lg pr-8 pl-2 text-left transition-colors duration-100",
          selected ? "bg-cream-hover" : "hover:bg-cream-hover",
        )}
      >
        {working || t.status === "failed" ? (
          <StatusDot status={t.status} className="mx-[5px]" />
        ) : agentIcon ? (
          <AgentBadge kind={t.agent.kind} />
        ) : t.mode === "cloud" ? (
          <Cloud aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
        ) : (
          <Laptop aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
        )}
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t.title}</span>
        <span className="shrink-0 text-[12.5px] text-ink-faint tabular-nums group-hover/row:invisible">{relativeTime(t.updatedAt)}</span>
        <span className="sr-only">
          {t.mode === "cloud" ? "Cloud" : "On this computer"}, {AGENT_LABELS[t.agent.kind]}, {STATUS_LABELS[t.status]}
        </span>
      </button>
      <div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100 focus-within:opacity-100">
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              aria-label={`Options for ${t.title}`}
              className="inline-flex size-6 items-center justify-center rounded-md text-ink-soft hover:bg-cream data-[popup-open]:bg-cream"
            >
              <Ellipsis aria-hidden="true" className="size-4" />
            </button>
          }
        >
          {!archived && (
            <MenuItem icon={pinned ? <PinOff /> : <Pin />} onSelect={() => onPin(!pinned)}>
              {pinned ? "Unpin" : "Pin to top"}
            </MenuItem>
          )}
          <MenuItem icon={archived ? <ArchiveRestore /> : <Archive />} onSelect={() => onArchive(!archived)}>
            {archived ? "Unarchive" : "Archive"}
          </MenuItem>
          <MenuItem icon={<FolderGit2 />} onSelect={() => void navigator.clipboard?.writeText(t.branch)}>
            Copy branch name
          </MenuItem>
        </Menu>
      </div>
    </li>
  );
}

interface Group {
  key: string;
  label: string;
  icon: ReactNode;
  threads: ThreadSummary[];
}

function groupThreads(threads: ThreadSummary[], prefs: UiPrefs): Group[] {
  const pinned = threads.filter(t => prefs.pinned.includes(t.id));
  const rest = threads.filter(t => !prefs.pinned.includes(t.id));
  const groups = new Map<string, Group>();
  for (const t of rest) {
    const key = prefs.organize === "place" ? t.mode : prefs.organize === "agent" ? t.agent.kind : repoName(t.repo);
    const label =
      prefs.organize === "place"
        ? t.mode === "cloud"
          ? "Cloud"
          : "On this computer"
        : prefs.organize === "agent"
          ? AGENT_LABELS[t.agent.kind]
          : repoName(t.repo);
    const icon =
      prefs.organize === "place" ? (
        t.mode === "cloud" ? (
          <Cloud aria-hidden="true" className="size-3.5" />
        ) : (
          <Laptop aria-hidden="true" className="size-3.5" />
        )
      ) : (
        <FolderGit2 aria-hidden="true" className="size-3.5" />
      );
    if (!groups.has(key)) groups.set(key, { key, label, icon, threads: [] });
    groups.get(key)!.threads.push(t);
  }
  const out = [...groups.values()];
  if (pinned.length) out.unshift({ key: "pinned", label: "Pinned", icon: <Pin aria-hidden="true" className="size-3.5" />, threads: pinned });
  return out;
}

function AgentBadge({ kind }: { kind: ThreadSummary["agent"]["kind"] }) {
  const letter = { "claude-code": "C", codex: "X", opencode: "O", acp: "A" }[kind];
  return (
    <span
      aria-hidden="true"
      title={AGENT_LABELS[kind]}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-cream-hover text-[10px] font-semibold text-ink-soft"
    >
      {letter}
    </span>
  );
}

function CustomizeNav({ prefs, onPrefs, onDone }: { prefs: UiPrefs; onPrefs: (p: Partial<UiPrefs>) => void; onDone: () => void }) {
  const order = [...prefs.navOrder, ...NAV_ITEMS.filter(i => !prefs.navOrder.includes(i))];
  const [dragging, setDragging] = useState<NavItem | null>(null);
  const place = (item: NavItem, to: number) => {
    const next = order.filter(x => x !== item);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
    onPrefs({ navOrder: next });
  };
  return (
    <div className="rounded-lg border border-line bg-cream/60 p-1">
      <div className="flex h-8 items-center px-2">
        <span className="flex-1 text-[13px] text-ink-soft">Drag to reorder</span>
        <button type="button" onClick={onDone} className="text-[13.5px] font-semibold text-ink hover:text-leaf">
          Done
        </button>
      </div>
      <ul>
        {order.map((item, i) => {
          const { label, icon: Icon } = NAV[item];
          const shown = !prefs.hiddenNav.includes(item);
          return (
            <li
              key={item}
              draggable
              onDragStart={e => {
                setDragging(item);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={e => {
                if (!dragging || dragging === item) return;
                e.preventDefault();
                place(dragging, i);
              }}
              className={cx("flex h-[30px] items-center gap-2 rounded-lg px-1.5 hover:bg-cream-hover", dragging === item && "bg-cream-hover opacity-70")}
            >
              <button
                type="button"
                aria-label={`Move ${label}. Up and down arrows move it.`}
                onKeyDown={e => {
                  if (e.key === "ArrowUp" && i > 0) {
                    e.preventDefault();
                    place(item, i - 1);
                  } else if (e.key === "ArrowDown" && i < order.length - 1) {
                    e.preventDefault();
                    place(item, i + 1);
                  }
                }}
                className="cursor-grab text-ink-faint active:cursor-grabbing"
              >
                <GripVertical aria-hidden="true" className="size-3.5" />
              </button>
              <Icon aria-hidden="true" className="size-4 text-ink-soft" />
              <label htmlFor={`nav-${item}`} className="flex-1 text-[14px]">
                {label}
              </label>
              <input
                id={`nav-${item}`}
                type="checkbox"
                checked={shown}
                onChange={e => onPrefs({ hiddenNav: e.target.checked ? prefs.hiddenNav.filter(x => x !== item) : [...prefs.hiddenNav, item] })}
                className="size-4 accent-[var(--color-leaf)]"
              />
            </li>
          );
        })}
      </ul>
      <p className="px-2 pt-1 pb-1.5 text-[12.5px] text-ink-faint">
        Search is always on <Kbd>⌘ K</Kbd>
      </p>
    </div>
  );
}
