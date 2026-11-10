import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AlarmClock,
  Archive,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BookOpen,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Hourglass,
  MessageCircleQuestion,
  PencilLine,
  Download,
  FolderPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Cloud,
  Columns2,
  Ellipsis,
  FolderGit2,
  FolderOpen,
  GripVertical,
  Laptop,
  Layers,
  MessageSquare,
  PanelLeft,
  Pin,
  Plus,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  SquarePen,
  Server,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { ThreadSummary } from "../lib/threads.ts";
import { useMachines } from "../lib/machines.ts";
import { AGENT_LABELS, STATUS_LABELS, relativeTime, repoName } from "../lib/format.ts";
import { NAV_ITEMS, type NavItem, type SidebarChild, type UiPrefs } from "../lib/storage.ts";
import { CHILD_STATE_LABEL, childrenSummary, gridCells } from "../lib/children.ts";
import { ContextMenu, Kbd, Menu, MenuChoice, MenuItem, MenuSeparator, SubMenu, Tip, Toggle } from "./primitives.tsx";
import {
  GROUP_ROWS,
  carryGroupKeys,
  groupThreads,
  moveGroup,
  orderGroups,
  splitSnoozed,
  toggleKey,
  groupRows,
  type GroupProject,
  type ThreadGroup,
} from "../lib/sidebarGroups.ts";
import { knownPullRequestInfo, knownPullRequests, snoozeWhen, subscribePullRequests } from "../lib/threadMenu.ts";
import { threadCardLines } from "../lib/threadCard.ts";
import { ThreadPeekTrigger, ThreadPeek } from "./ThreadPeek.tsx";
import { useMissingFolders } from "../lib/missingFolders.ts";
import { RenameField, ThreadMenu, ThreadRightClickMenu, type ThreadMenuProps } from "./ThreadMenu.tsx";
import { GLYPH_LABELS, type RowGlyph } from "../lib/threadState.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { IS_MAC, rowShortcut, type ShortcutId } from "../lib/shortcuts.ts";
import { LogoMark, Spinner, StatusDot, cx, openExternal } from "./ui.tsx";

export interface AppSidebarProps {
  threads: ThreadSummary[];
  cloudConfigured: boolean;
  cloudLoading: boolean;
  cloudError: string | null;
  selectedId: string | null;
  /** The page on screen, so its sidebar entry shows as current. */
  currentNav?: NavItem | null;
  prefs: UiPrefs;
  onPrefs: (patch: Partial<UiPrefs>) => void;
  onSelect: (t: ThreadSummary) => void;
  onNew: () => void;
  onAutomations: () => void;
  onSkills: () => void;
  onPlugins: () => void;
  /** Pick a folder to start threads in. */
  onNewProject: () => void;
  /** Agent CLIs on this computer older than LemonLime is tested with (labels). */
  agentUpdates?: string[];
  onSettings: (page?: string) => void;
  onBack: (() => void) | null;
  onForward: (() => void) | null;
  /** The last archive, pin or mark as unread, with its Undo (⌘Z does the same). */
  undoNotice?: { label: string; detail?: string | undefined; onUndo: () => void; onDismiss: () => void };
  /** Card above the footer, e.g. cloud hours left (from the deployment). */
  usageCard?: ReactNode;
  /** The notification bell, given the footer buttons' class. */
  notifications?: (className: string) => ReactNode;
  onArchive: (t: ThreadSummary, archive: boolean) => void;
  /** The thread rows in the order shown, as they change (⌘1–9 go to them). */
  onRowOrder?: (ids: string[]) => void;
  /** Mark the first nine rows with ⌘1–9 for the hints shown while ⌘ is held (not while split). */
  numberRows?: boolean;
  /** Pin a thread to the top, or unpin it. */
  onPin?: (t: ThreadSummary, pin: boolean) => void;
  /** Snooze a thread until a time, ask for a time ("custom"), or wake it (null). */
  onSnooze?: (t: ThreadSummary, until: Date | "custom" | null) => void;
  /** Each thread's status mark (see threadState.ts); missing means none. */
  glyphs?: Record<string, RowGlyph>;
  /** Each thread's latest subagents, nested under it. */
  childrenOf?: Record<string, SidebarChild[]>;
  /** Unread threads show their title in bold. */
  unread?: Set<string>;
  onMarkUnread?: (t: ThreadSummary, unread: boolean) => void;
  onRename?: (t: ThreadSummary, title: string) => void;
  /** Shows traffic lights' room in the capsule (macOS app window). */
  macChrome: boolean;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
  /** Threads showing in the split view, marked in the list. */
  openInSplit?: Set<string>;
  onOpenInSplit?: (t: ThreadSummary) => void;
  /** A thread row is being dragged (to drop on a pane), or the drag ended (null). */
  onDragThread?: (t: ThreadSummary | null) => void;
  /** Start a new thread in a group's project (Home, with the project chosen). */
  onNewInProject?: (project: GroupProject) => void;
  /** Open a project folder on this computer (in the editor, or the file manager). */
  onOpenProjectFolder?: (path: string) => void;
  /** Take a project off the list: its threads are archived. */
  onRemoveProject?: (group: ThreadGroup) => void;
  /** Start a new thread that carries on from this one. */
  onFork?: (t: ThreadSummary) => void;
  /** Open a thread's folder on this computer. */
  onOpenFolder?: (t: ThreadSummary) => void;
  /** Remove a local thread (asks first). */
  onRemove?: (t: ThreadSummary) => void;
  /** A subagent under a thread was clicked: open the thread at it. */
  onOpenChild?: (t: ThreadSummary, childId: string) => void;
  /** Folders open in an editor (Settings), rather than the file manager. */
  editor?: boolean;
}

/** The drag data type for a thread row. */
export const THREAD_DRAG_TYPE = "application/x-lemonlime-thread";

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
  const [threadsOpenSaved, setThreadsOpen] = useState(true);
  // Items added since the order was saved go at the end.
  const order = [...p.prefs.navOrder, ...NAV_ITEMS.filter(i => !p.prefs.navOrder.includes(i))];
  const visibleNav = order.filter(i => !p.prefs.hiddenNav.includes(i));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? p.threads.filter(t => `${t.title} ${repoName(t.repo)} ${t.branch} ${AGENT_LABELS[t.agent.kind]}`.toLowerCase().includes(q)) : p.threads;
    return p.prefs.sort === "name" ? [...list].sort((a, b) => a.title.localeCompare(b.title)) : list;
  }, [p.threads, query, p.prefs.sort]);

  // While something is typed in the search box, every match shows: folded groups open and nothing waits behind "Show more".
  const filtering = query.trim() !== "";
  const threadsOpen = threadsOpenSaved || filtering;
  // However the search box closes, its filter goes with it.
  useEffect(() => {
    if (!p.searchOpen) setQuery("");
  }, [p.searchOpen]);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const archived = useMemo(() => filtered.filter(t => p.prefs.archived[t.id]), [filtered, p.prefs.archived]);
  // Snoozed threads leave the list until they come back (the app ends snoozes when they're due).
  const { awake, snoozed } = useMemo(
    () =>
      splitSnoozed(
        filtered.filter(t => !p.prefs.archived[t.id]),
        p.prefs.snoozed,
        Date.now(),
      ),
    [filtered, p.prefs.archived, p.prefs.snoozed],
  );
  const machines = useMachines();
  const groups = useMemo(
    () =>
      orderGroups(
        groupThreads(awake, { organize: p.prefs.organize, pinned: p.prefs.pinned, machineName: id => machines.find(m => m.id === id)?.name, all: p.threads }),
        p.prefs.groupOrder,
      ),
    [awake, p.threads, p.prefs.organize, p.prefs.pinned, p.prefs.groupOrder, machines],
  );
  // A project's order and folding, saved under its short name before, move to the key it has now.
  useEffect(() => {
    const groupOrder = carryGroupKeys(p.prefs.groupOrder, groups);
    const collapsedGroups = carryGroupKeys(p.prefs.collapsedGroups, groups);
    if (groupOrder || collapsedGroups) p.onPrefs({ ...(groupOrder ? { groupOrder } : {}), ...(collapsedGroups ? { collapsedGroups } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, p.prefs.groupOrder, p.prefs.collapsedGroups]);
  // The open thread is never out of sight: its snoozed list opens with it.
  const showSnoozed = snoozedOpen || filtering || snoozed.some(t => t.id === p.selectedId);
  const showArchived = archivedOpen || filtering;
  const pin = (t: ThreadSummary, on: boolean) =>
    p.onPin ? p.onPin(t, on) : p.onPrefs({ pinned: on ? [t.id, ...p.prefs.pinned] : p.prefs.pinned.filter(id => id !== t.id) });
  // One group of anything but a project needs no heading.
  const showHeaders = groups.length > 1 || groups[0]?.kind === "project";
  const movable = groups.filter(g => g.kind !== "pinned").map(g => g.key);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const missing = useMissingFolders(groups.flatMap(g => (g.project?.mode === "local" ? [g.project.path] : [])));
  const pullRequests = useSyncExternalStore(subscribePullRequests, knownPullRequests);
  const isCollapsed = (key: string) => showHeaders && !filtering && p.prefs.collapsedGroups.includes(key);
  const rowsOf = (g: ThreadGroup) => groupRows(g.threads, { expanded: filtering || expanded.has(g.key), selectedId: p.selectedId });
  // Folding waits while a search shows every match, so nothing is folded out of sight unseen.
  const toggleGroup = (key: string) => (filtering ? undefined : p.onPrefs({ collapsedGroups: toggleKey(p.prefs.collapsedGroups, key) }));
  const moveTo = (key: string, to: number) => p.onPrefs({ groupOrder: moveGroup(p.prefs.groupOrder, movable, key, to) });
  const headed = showHeaders ? groups : [];
  // The rows as listed, top to bottom: folded groups and rows behind "Show more" aren't there.
  const rowOrder = useMemo(
    () => (threadsOpen ? groups.flatMap(g => (isCollapsed(g.key) ? [] : rowsOf(g).shown.map(t => t.id))) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadsOpen, groups, showHeaders, filtering, p.prefs.collapsedGroups, expanded, p.selectedId],
  );
  const rowKey = rowOrder.join(" ");
  const { onRowOrder } = p;
  useEffect(() => onRowOrder?.(rowKey ? rowKey.split(" ") : []), [rowKey, onRowOrder]);
  const rowNumber = useMemo(() => new Map(rowOrder.slice(0, 9).map((id, i) => [id, i + 1])), [rowOrder]);
  const allCollapsed = headed.length > 0 && headed.every(g => p.prefs.collapsedGroups.includes(g.key));

  /** The thread list's options, on its ⋯ and on a right-click on its heading. */
  const listOptions = (withNew: boolean) => (
    <>
      {withNew && (
        <MenuItem icon={<SquarePen />} onSelect={p.onNew} hint="⌘N">
          New thread
        </MenuItem>
      )}
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
      {headed.length > 1 && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            onSelect={() => {
              const keys = headed.map(g => g.key);
              p.onPrefs({
                collapsedGroups: allCollapsed ? p.prefs.collapsedGroups.filter(k => !keys.includes(k)) : [...new Set([...p.prefs.collapsedGroups, ...keys])],
              });
            }}
          >
            {allCollapsed ? "Expand all groups" : "Collapse all groups"}
          </MenuItem>
        </>
      )}
    </>
  );

  /** What a row's menus can do, besides what the row handles itself. */
  const rowActions = (t: ThreadSummary) => {
    const here = t.mode === "local" && !t.machine;
    return {
      ...(p.onRename ? { onRename: (title: string) => p.onRename!(t, title) } : {}),
      ...(p.onMarkUnread && !p.prefs.archived[t.id] ? { onMarkUnread: (u: boolean) => p.onMarkUnread!(t, u) } : {}),
      ...(p.onFork ? { onFork: () => p.onFork!(t) } : {}),
      ...(p.onOpenFolder && here ? { onOpenFolder: () => p.onOpenFolder!(t) } : {}),
      ...(p.onRemove && t.mode === "local" ? { onRemove: () => p.onRemove!(t) } : {}),
      ...(p.onOpenChild ? { onOpenChild: (childId: string) => p.onOpenChild!(t, childId) } : {}),
      ...(p.onSnooze && !p.prefs.archived[t.id] ? { onSnooze: (until: Date | "custom" | null) => p.onSnooze!(t, until) } : {}),
    };
  };

  const navAction = (item: NavItem) => {
    if (item === "new") p.onNew();
    else if (item === "automations") p.onAutomations();
    else if (item === "skills") p.onSkills();
    else if (item === "plugins") p.onPlugins();
    else p.onSearchOpen(!p.searchOpen);
  };

  return (
    <nav aria-label="LemonLime" className="flex w-full min-w-0 flex-col border-r border-line bg-cream-deep">
      <ThreadPeek />
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
              const current = item === p.currentNav;
              return (
                <li key={item}>
                  <button
                    type="button"
                    aria-current={current ? "page" : undefined}
                    className={cx(ROW, ((item === "search" && p.searchOpen) || current) && "bg-cream-hover")}
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
            <button
              type="button"
              aria-label="Close search"
              onClick={() => (setQuery(""), p.onSearchOpen(false))}
              className="-mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-cream-hover hover:text-ink"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </label>
        </div>
      )}

      {/* Threads */}
      <ContextMenu menu={listOptions(true)}>
        <div className="group/threads flex h-8 items-center gap-1 px-2 pl-4">
          <button
            type="button"
            onClick={() => setThreadsOpen(o => !o)}
            aria-expanded={threadsOpen}
            className="flex flex-1 items-center gap-1 text-left text-[13px] text-ink-soft hover:text-ink"
          >
            Threads
            <ChevronDown
              aria-hidden="true"
              className={cx("size-3.5 opacity-0 transition-opacity duration-150 group-hover/threads:opacity-100", !threadsOpen && "-rotate-90 opacity-100")}
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
            {listOptions(false)}
          </Menu>
        </div>
      </ContextMenu>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {threadsOpen &&
          (filtered.length === 0 ? (
            <p className="flex h-8 items-center gap-2.5 px-2 text-[14px] text-ink-faint">
              <MessageSquare aria-hidden="true" className="size-4" />
              {query ? "No threads match" : "No threads"}
            </p>
          ) : (
            groups.map(g => {
              const collapsed = isCollapsed(g.key);
              const { shown, hidden } = rowsOf(g);
              const canMore = !filtering && g.threads.length > GROUP_ROWS + 1;
              return (
                <section key={g.key} aria-label={g.label} className="mb-2">
                  {showHeaders && (
                    <GroupHeader
                      group={g}
                      collapsed={collapsed}
                      missing={g.project?.mode === "local" && missing.has(g.project.path)}
                      movable={movable}
                      onToggle={() => toggleGroup(g.key)}
                      onMove={moveTo}
                      drag={dragGroup}
                      onDrag={setDragGroup}
                      {...(p.onNewInProject ? { onNewInProject: p.onNewInProject } : {})}
                      {...(p.onOpenProjectFolder ? { onOpenFolder: p.onOpenProjectFolder } : {})}
                      {...(p.onRemoveProject ? { onRemove: () => p.onRemoveProject!(g) } : {})}
                    />
                  )}
                  {!collapsed && (
                    <ul className="flex flex-col gap-px">
                      {shown.map(t => (
                        <ThreadRow
                          key={`${t.mode}:${t.id}`}
                          t={t}
                          selected={t.id === p.selectedId}
                          pinned={p.prefs.pinned.includes(t.id)}
                          onSelect={p.onSelect}
                          agentIcon={p.prefs.agentIcons}
                          onPin={on => pin(t, on)}
                          archived={false}
                          onArchive={a => p.onArchive(t, a)}
                          glyph={p.glyphs?.[t.id] ?? null}
                          kids={p.childrenOf?.[t.id] ?? []}
                          showKids={!p.prefs.collapseChildren}
                          unread={p.unread?.has(t.id) ?? false}
                          editor={p.editor ?? false}
                          prUrl={pullRequests.get(t.id) ?? null}
                          {...rowActions(t)}
                          inSplit={p.openInSplit?.has(t.id) ?? false}
                          {...(p.numberRows && rowNumber.has(t.id) ? { shortcut: rowShortcut(rowNumber.get(t.id)!) ?? undefined } : {})}
                          {...(p.onOpenInSplit ? { onOpenInSplit: () => p.onOpenInSplit!(t) } : {})}
                          {...(p.onDragThread ? { onDrag: p.onDragThread } : {})}
                        />
                      ))}
                      {canMore && (
                        <li>
                          <button
                            type="button"
                            onClick={() => setExpanded(s => toggleSet(s, g.key))}
                            className="flex h-7 w-full items-center rounded-lg pl-[34px] text-left text-[13px] text-ink-faint transition-colors duration-100 hover:bg-cream-hover hover:text-ink"
                          >
                            {hidden > 0 ? `Show ${hidden} more` : "Show less"}
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              );
            })
          ))}
        {threadsOpen && snoozed.length > 0 && (
          <section aria-label="Snoozed" className="mb-2">
            <button
              type="button"
              aria-expanded={showSnoozed}
              onClick={() => setSnoozedOpen(!showSnoozed)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-ink-faint hover:text-ink"
            >
              <Clock aria-hidden="true" className="size-3.5" />
              <span className="flex-1">Snoozed</span>
              <span className="tabular-nums">{snoozed.length}</span>
            </button>
            {showSnoozed && (
              <ul className="flex flex-col gap-px">
                {snoozed.map(t => (
                  <ThreadRow
                    key={`${t.mode}:${t.id}`}
                    t={t}
                    selected={t.id === p.selectedId}
                    pinned={p.prefs.pinned.includes(t.id)}
                    onSelect={p.onSelect}
                    agentIcon={p.prefs.agentIcons}
                    onPin={on => pin(t, on)}
                    archived={false}
                    onArchive={a => p.onArchive(t, a)}
                    glyph={p.glyphs?.[t.id] ?? null}
                    unread={p.unread?.has(t.id) ?? false}
                    editor={p.editor ?? false}
                    prUrl={pullRequests.get(t.id) ?? null}
                    snoozedUntil={p.prefs.snoozed[t.id]}
                    {...rowActions(t)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
        {threadsOpen && archived.length > 0 && (
          <section aria-label="Archived" className="mb-2">
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={() => setArchivedOpen(o => !o)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-ink-faint hover:text-ink"
            >
              <Archive aria-hidden="true" className="size-3.5" />
              <span className="flex-1">Archived</span>
              <span className="tabular-nums">{archived.length}</span>
            </button>
            {showArchived && (
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
                    glyph={null}
                    unread={false}
                    editor={p.editor ?? false}
                    prUrl={pullRequests.get(t.id) ?? null}
                    {...rowActions(t)}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
        {p.cloudError && <p className="px-2 py-1 text-[13px] leading-snug text-danger">{p.cloudError}</p>}
      </div>

      {p.usageCard && <div className="px-2 pb-2">{p.usageCard}</div>}

      {/* Said here, not in a toast: it belongs to the list. It answers a key as often as a click, so it doesn't animate. */}
      <div role="status" className="px-2 empty:hidden">
        {p.undoNotice && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-line bg-paper py-2 pr-1.5 pl-3 shadow-panel">
            <div className="min-w-0 flex-1 py-0.5">
              <p className="line-clamp-2 text-[13px] font-medium break-words text-ink" title={p.undoNotice.label}>
                {p.undoNotice.label}
              </p>
              {p.undoNotice.detail && <p className="mt-0.5 text-[13px] leading-snug text-pretty text-ink-soft">{p.undoNotice.detail}</p>}
            </div>
            <button
              type="button"
              onClick={p.undoNotice.onUndo}
              aria-keyshortcuts={IS_MAC ? "Meta+Z" : "Control+Z"}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-paper px-2 text-[13px] font-semibold text-ink hover:bg-cream active:scale-[0.97]"
            >
              Undo
              <span className="font-normal text-ink-faint">{IS_MAC ? "⌘Z" : "Ctrl+Z"}</span>
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={p.undoNotice.onDismiss}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-ink/5 hover:text-ink"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        )}
      </div>

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
        {p.notifications?.(FOOT)}
        <span className="flex-1" />
        {p.agentUpdates && p.agentUpdates.length > 0 && (
          <Tip label={`${p.agentUpdates.join(" and ")} ${p.agentUpdates.length === 1 ? "has" : "have"} an update`}>
            <button
              type="button"
              onClick={() => p.onSettings("agents")}
              aria-label="Agent updates"
              className="mr-1 inline-flex h-[26px] items-center gap-1.5 rounded-full border border-line bg-cream px-2 text-[13px] font-medium text-ink-soft hover:border-line-strong"
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
            className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-cream px-2.5 text-[13px] whitespace-nowrap font-medium text-ink-soft hover:border-line-strong"
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
  glyph,
  unread,
  onMarkUnread,
  onRename,
  inSplit = false,
  onOpenInSplit,
  onDrag,
  kids = [],
  showKids = true,
  onFork,
  onOpenFolder,
  onRemove,
  onOpenChild,
  editor = false,
  prUrl = null,
  snoozedUntil,
  onSnooze,
  shortcut,
}: {
  inSplit?: boolean;
  onOpenInSplit?: () => void;
  onDrag?: (t: ThreadSummary | null) => void;
  t: ThreadSummary;
  /** Subagents working (or done) for this thread. */
  kids?: SidebarChild[];
  /** List them under the row (the grid shows either way). */
  showKids?: boolean;
  selected: boolean;
  agentIcon?: boolean;
  pinned: boolean;
  onSelect: (t: ThreadSummary) => void;
  onPin: (pin: boolean) => void;
  archived: boolean;
  onArchive: (archive: boolean) => void;
  glyph: RowGlyph;
  unread: boolean;
  onMarkUnread?: (unread: boolean) => void;
  onRename?: (title: string) => void;
  onFork?: () => void;
  onOpenFolder?: () => void;
  onRemove?: () => void;
  onOpenChild?: (childId: string) => void;
  editor?: boolean;
  /** Its pull request, when the app has seen one. */
  prUrl?: string | null;
  /** Snoozed until then (ISO): the row says when it's back instead of when it last moved. */
  snoozedUntil?: string | undefined;
  onSnooze?: (until: Date | "custom" | null) => void;
  /** Its ⌘ number, shown while ⌘ is held. */
  shortcut?: ShortcutId | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const machines = useMachines();
  const machineName = t.machine ? (machines.find(m => m.id === t.machine)?.name ?? "a removed machine") : null;
  const menu: ThreadMenuProps = {
    thread: { title: t.title, branch: t.branch },
    state: { mode: t.mode, pinned, unread, archived, snoozed: Boolean(snoozedUntil), inSplit, editor, pullRequest: prUrl ? "view" : null },
    actions: {
      ...(onRename ? { rename: () => setRenaming(true) } : {}),
      pin: onPin,
      ...(onMarkUnread ? { unread: onMarkUnread } : {}),
      ...(onSnooze ? { snooze: onSnooze } : {}),
      ...(onOpenInSplit ? { split: onOpenInSplit } : {}),
      ...(onFork ? { fork: onFork } : {}),
      ...(onOpenFolder ? { openFolder: onOpenFolder } : {}),
      ...(prUrl ? { pullRequest: () => void openExternal(prUrl) } : {}),
      archive: onArchive,
      ...(onRemove ? { remove: onRemove } : {}),
    },
  };
  return (
    <ThreadRightClickMenu {...menu} disabled={renaming}>
      <li className="group/row relative">
        {renaming && onRename ? (
          <RenameField
            initial={t.title}
            onDone={title => {
              setRenaming(false);
              if (title !== null && title !== t.title) onRename(title);
            }}
          />
        ) : (
          <ThreadPeekTrigger
            payload={{
              title: t.title,
              lines: threadCardLines(t, { machineName, pullRequest: prUrl ? (knownPullRequestInfo(t.id) ?? {}) : null, snoozedUntil: snoozedUntil ?? null }),
            }}
            render={
              <button
                type="button"
                onClick={() => onSelect(t)}
                onDoubleClick={e => {
                  if (!onRename) return;
                  e.preventDefault();
                  setRenaming(true);
                }}
                aria-current={selected ? "page" : undefined}
                aria-keyshortcuts="Shift+F10"
                data-shortcut={shortcut}
                // Drag it onto a pane to open it there, or onto a pane's edge to split.
                draggable={Boolean(onDrag)}
                onDragStart={e => {
                  if (!onDrag) return;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify({ mode: t.mode, id: t.id }));
                  e.dataTransfer.setData("text/plain", t.title);
                  onDrag(t);
                }}
                onDragEnd={() => onDrag?.(null)}
                className={cx(
                  "flex h-8 w-full items-center gap-2.5 rounded-lg pr-8 pl-2 text-left transition-colors duration-100",
                  selected ? "bg-cream-hover" : "hover:bg-cream-hover",
                )}
              >
                {glyph ? (
                  <RowMark glyph={glyph} status={t.status} />
                ) : agentIcon ? (
                  <AgentBadge kind={t.agent.kind} />
                ) : t.mode === "cloud" ? (
                  <Cloud aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
                ) : t.machine ? (
                  <Server aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
                ) : (
                  <Laptop aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
                )}
                <span className={cx("min-w-0 flex-1 truncate text-[14px] text-ink", unread && "font-semibold")}>{t.title}</span>
                {inSplit && (
                  <span
                    role="img"
                    aria-label="Open in the split view"
                    title="Open in the split view"
                    className="inline-flex shrink-0 group-hover/row:invisible"
                  >
                    <Columns2 aria-hidden="true" className="size-3.5 text-ink-faint" />
                  </span>
                )}
                {kids.length > 0 && <ProgressGrid kids={kids} />}
                <span className="shrink-0 text-[12px] text-ink-faint tabular-nums group-hover/row:invisible">
                  {snoozedUntil ? snoozeWhen(new Date(snoozedUntil), new Date(), true) : relativeTime(t.updatedAt)}
                </span>
                <span className="sr-only">
                  {t.mode === "cloud" ? "Cloud" : machineName ? `On ${machineName}` : "On this computer"}, {AGENT_LABELS[t.agent.kind]},{" "}
                  {STATUS_LABELS[t.status]}
                  {glyph && glyph !== "working" && glyph !== "failed" ? `, ${GLYPH_LABELS[glyph]}` : ""}
                  {snoozedUntil ? `, snoozed until ${snoozeWhen(new Date(snoozedUntil), new Date())}` : ""}
                </span>
              </button>
            }
          />
        )}
        {showKids && kids.length > 0 && !renaming && (
          <ul aria-label={`Subagents of ${t.title}`} className="mt-px mb-0.5 flex flex-col">
            {kids.slice(0, KIDS_LISTED).map(k => (
              <li key={k.id}>
                <button
                  type="button"
                  onClick={() => (onOpenChild ? onOpenChild(k.id) : onSelect(t))}
                  title={k.title}
                  className="flex h-7 w-full items-center gap-2 rounded-lg pr-2 pl-[30px] text-left text-[13px] text-ink-soft transition-colors duration-100 hover:bg-cream-hover"
                >
                  <ChildMark state={k.state} />
                  <span className="min-w-0 flex-1 truncate">{k.title}</span>
                  <span className="sr-only">, {CHILD_STATE_LABEL[k.state]}</span>
                </button>
              </li>
            ))}
            {kids.length > KIDS_LISTED && (
              <li className="flex h-6 items-center pl-[30px] text-[12px] text-ink-faint tabular-nums">and {kids.length - KIDS_LISTED} more</li>
            )}
          </ul>
        )}
        <div
          className={cx(
            "absolute top-4 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100 focus-within:opacity-100",
            renaming && "hidden",
          )}
        >
          <ThreadMenu
            {...menu}
            trigger={
              <button
                type="button"
                aria-label={`Options for ${t.title}`}
                className="inline-flex size-6 items-center justify-center rounded-md text-ink-soft hover:bg-cream data-[popup-open]:bg-cream"
              >
                <Ellipsis aria-hidden="true" className="size-4" />
              </button>
            }
          />
        </div>
      </li>
    </ThreadRightClickMenu>
  );
}

/** A group's heading: fold it, start a thread in its project, drag it into place, or right-click for more. */
function GroupHeader({
  group: g,
  collapsed,
  missing,
  movable,
  onToggle,
  onMove,
  drag,
  onDrag,
  onNewInProject,
  onOpenFolder,
  onRemove,
}: {
  group: ThreadGroup;
  collapsed: boolean;
  /** Its folder on this computer is gone. */
  missing: boolean;
  /** The keys of the groups that can be moved, in order. */
  movable: string[];
  onToggle: () => void;
  /** Move a group (this one, or the one dropped on it) to a place among the others (see moveGroup). */
  onMove: (key: string, to: number) => void;
  /** The group being dragged, if any. */
  drag: string | null;
  onDrag: (key: string | null) => void;
  onNewInProject?: (project: GroupProject) => void;
  onOpenFolder?: (path: string) => void;
  onRemove?: () => void;
}) {
  const [drop, setDrop] = useState<"before" | "after" | null>(null);
  const index = movable.indexOf(g.key);
  const canMove = index >= 0 && movable.length > 1;
  const local = g.project?.mode === "local" ? g.project.path : null;
  const project = g.project && !missing ? g.project : null;
  const icon =
    g.kind === "pinned" ? (
      <Pin />
    ) : g.kind === "cloud" ? (
      <Cloud />
    ) : g.kind === "machine" ? (
      <Server />
    ) : g.kind === "computer" ? (
      <Laptop />
    ) : g.kind === "agent" && g.agent ? (
      <AgentIcon kind={g.agent} className="size-3.5" />
    ) : (
      <FolderGit2 />
    );
  const menu = (
    <>
      {project && onNewInProject && (
        <MenuItem icon={<SquarePen />} onSelect={() => onNewInProject(project)}>
          New thread in this project
        </MenuItem>
      )}
      <MenuItem icon={collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />} onSelect={onToggle}>
        {collapsed ? "Expand" : "Collapse"}
      </MenuItem>
      {local && onOpenFolder && (
        <MenuItem icon={<FolderOpen />} disabled={missing} {...(missing ? { hint: "Folder missing" } : {})} onSelect={() => onOpenFolder(local)}>
          Open folder
        </MenuItem>
      )}
      {canMove && (
        <>
          <MenuSeparator />
          <MenuItem icon={<ArrowUp />} disabled={index === 0} onSelect={() => onMove(g.key, index - 1)}>
            Move up
          </MenuItem>
          <MenuItem icon={<ArrowDown />} disabled={index === movable.length - 1} onSelect={() => onMove(g.key, index + 1)}>
            Move down
          </MenuItem>
        </>
      )}
      {g.kind === "project" && onRemove && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={onRemove}>
            Remove from list
          </MenuItem>
        </>
      )}
    </>
  );
  const dragging = drag !== null && drag !== g.key && canMove;
  return (
    <ContextMenu menu={menu}>
      <div
        className="group/head relative flex h-7 items-center gap-0.5 pr-1"
        draggable={canMove}
        onDragStart={e => {
          if (!canMove) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(GROUP_DRAG_TYPE, g.key);
          onDrag(g.key);
        }}
        onDragEnd={() => {
          onDrag(null);
          setDrop(null);
        }}
        onDragOver={e => {
          if (!dragging || !e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const r = e.currentTarget.getBoundingClientRect();
          setDrop(e.clientY < r.top + r.height / 2 ? "before" : "after");
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={e => {
          if (!dragging || !drag) return;
          e.preventDefault();
          const rest = movable.filter(k => k !== drag);
          const at = rest.indexOf(g.key) + (drop === "after" ? 1 : 0);
          setDrop(null);
          onDrag(null);
          onMove(drag, at);
        }}
      >
        {drop && dragging && (
          <span
            aria-hidden="true"
            className={cx("pointer-events-none absolute right-1 left-2 h-0.5 rounded-full bg-leaf", drop === "before" ? "-top-px" : "-bottom-px")}
          />
        )}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-keyshortcuts="Shift+F10"
          onClick={onToggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-ink-faint hover:text-ink [&_svg]:size-3.5 [&_svg]:shrink-0"
        >
          {icon}
          <span className="truncate">{g.label}</span>
          {missing && (
            <span role="img" aria-label="Folder missing" title="This folder is missing. It may have been moved or deleted." className="inline-flex">
              <CircleAlert aria-hidden="true" className="text-amber" />
            </span>
          )}
          {collapsed && <span className="text-ink-faint tabular-nums">{g.threads.length}</span>}
          <ChevronDown
            aria-hidden="true"
            className={cx("opacity-0 transition-opacity duration-150 group-hover/head:opacity-100", collapsed && "-rotate-90 opacity-100")}
          />
        </button>
        {project && onNewInProject && (
          <Tip label={`New thread in ${g.label}`}>
            <button
              type="button"
              aria-label={`New thread in ${g.label}`}
              onClick={() => onNewInProject(project)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-soft opacity-0 transition-opacity group-hover/head:opacity-100 hover:bg-cream-hover focus-visible:opacity-100"
            >
              <Plus aria-hidden="true" className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
    </ContextMenu>
  );
}

/** The drag data type for a group heading. */
const GROUP_DRAG_TYPE = "application/x-lemonlime-group";

/** Subagents listed under a thread before "and N more". */
const KIDS_LISTED = 4;

/** Each cell's look: every state has its own shape as well as colour. */
const CELL: Record<SidebarChild["state"], string> = {
  done: "bg-leaf",
  running: "bg-lime ring-1 ring-inset ring-leaf/60",
  waiting: "border-[1.5px] border-amber bg-transparent",
  failed: "bg-danger [clip-path:polygon(50%_0,100%_50%,50%_100%,0_50%)]",
  stopped: "bg-ink-faint/35",
};

/** One small cell per subagent: done, running, waiting, stopped or failed. */
function ProgressGrid({ kids }: { kids: SidebarChild[] }) {
  const { cells, more } = gridCells(kids);
  return (
    <span title={childrenSummary(kids)} className="flex max-w-[64px] shrink-0 flex-wrap items-center gap-[2px]">
      {cells.map(c => (
        <span key={c.id} role="img" aria-label={`${c.title}: ${CHILD_STATE_LABEL[c.state]}`} className={cx("size-[7px] rounded-[2px]", CELL[c.state])} />
      ))}
      {more > 0 && <span className="text-[12px] leading-none text-ink-faint tabular-nums">+{more}</span>}
    </span>
  );
}

function ChildMark({ state }: { state: SidebarChild["state"] }) {
  if (state === "running") return <Spinner className="size-3 shrink-0 text-leaf" />;
  if (state === "waiting") return <Hourglass aria-hidden="true" className="size-3.5 shrink-0 text-amber" />;
  if (state === "failed") return <CircleX aria-hidden="true" className="size-3.5 shrink-0 text-danger" />;
  if (state === "stopped") return <CircleMinus aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />;
  return <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-leaf" />;
}

/** The row's one status mark. Each has its own shape, so none relies on colour alone. */
function RowMark({ glyph, status }: { glyph: Exclude<RowGlyph, null>; status: ThreadSummary["status"] }) {
  const label = GLYPH_LABELS[glyph];
  if (glyph === "working") return <StatusDot status={status} className="mx-[5px]" />;
  if (glyph === "failed") return <StatusDot status="failed" className="mx-[5px]" />;
  const icon =
    glyph === "error" ? (
      <CircleAlert className="size-4 text-danger" />
    ) : glyph === "waiting" ? (
      <MessageCircleQuestion className="size-4 text-amber" />
    ) : glyph === "draft" ? (
      <PencilLine className="size-4 text-ink-faint" />
    ) : (
      <span className="mx-[4px] block size-2 rounded-full bg-leaf ring-2 ring-lime-soft" />
    );
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex size-4 shrink-0 items-center justify-center [&_svg]:shrink-0">
      {icon}
    </span>
  );
}

/** A copy of the set with `key` added, or taken out if it was there. */
function toggleSet(s: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(s);
  if (!next.delete(key)) next.add(key);
  return next;
}

function AgentBadge({ kind }: { kind: ThreadSummary["agent"]["kind"] }) {
  return (
    <span title={AGENT_LABELS[kind]} className="inline-flex shrink-0 text-ink-soft">
      <AgentIcon kind={kind} />
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
        <button type="button" onClick={onDone} className="text-[14px] font-semibold text-ink hover:text-leaf">
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
              <span className="flex-1 text-[14px]">{label}</span>
              <Toggle
                label={`Show ${label} in the sidebar`}
                checked={shown}
                onChange={on => onPrefs({ hiddenNav: on ? prefs.hiddenNav.filter(x => x !== item) : [...prefs.hiddenNav, item] })}
              />
            </li>
          );
        })}
      </ul>
      <p className="px-2 pt-1 pb-1.5 text-[13px] text-ink-faint">
        Search is always on <Kbd>⌘ K</Kbd>
      </p>
    </div>
  );
}
