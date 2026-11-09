import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Bug,
  Database,
  FileDiff,
  FileSearch,
  FileText,
  FlaskConical,
  Globe,
  Hammer,
  History,
  ListChecks,
  MessagesSquare,
  Package,
  Play,
  Plus,
  Rocket,
  Server,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { MAX_TERMINALS, type ScriptIcon, type ScriptKeybinding } from "@lemonlime/protocol";
import type { Script } from "../lib/projectScripts.ts";
import type { useThreadSession } from "../lib/useThreadSession.ts";
import {
  activeTab,
  clampPanel,
  closeTab,
  fileName,
  isBuiltIn,
  moveTab,
  newTerminal,
  openFile,
  PANEL_WIDTH,
  panelBounds,
  snapPanel,
  stepPanel,
  terminalCount,
  terminalLabel,
  type BuiltInTab,
  type PanelState,
  type PanelTab,
} from "../lib/panel.ts";
import { loadPanelWidth, savePanelWidth } from "../lib/storage.ts";
import { keyCaps } from "../lib/shortcuts.ts";
import { DiffView } from "./DiffView.tsx";
import { FileView } from "./FileView.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { SideChatPanel } from "./SideChatPanel.tsx";
import { closeTerminal, TerminalPanel } from "./TerminalPanel.tsx";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Tip } from "./primitives.tsx";
import { cx } from "./ui.tsx";

type Session = ReturnType<typeof useThreadSession>;

const BUILT_IN: Record<BuiltInTab, { label: string; icon: typeof FileDiff }> = {
  changes: { label: "Changes", icon: FileDiff },
  browser: { label: "Browser", icon: Globe },
  side: { label: "Side chat", icon: MessagesSquare },
};

/** Each icon a project script can pick. */
const SCRIPT_ICONS: Record<ScriptIcon, LucideIcon> = {
  play: Play,
  test: FlaskConical,
  lint: ListChecks,
  build: Hammer,
  server: Server,
  package: Package,
  wrench: Wrench,
  terminal: SquareTerminal,
  bug: Bug,
  rocket: Rocket,
  database: Database,
  sparkles: Sparkles,
};
export const scriptIcon = (icon: ScriptIcon | undefined): LucideIcon => (icon ? SCRIPT_ICONS[icon] : Play);

/** How long to wait for a script's preview address to answer before opening it anyway. */
const PREVIEW_WAIT_MS = 60_000;

/** Below this width the built-in tabs show only their icons. */
const COMPACT_BELOW = 560;

/**
 * The thread's panel: what the agent changed, a browser, a side chat, and as many
 * terminals and files as the user opens, in tabs they can reorder. Tabs are remembered per
 * thread; the width is remembered on this computer.
 */
export function ThreadPanel({
  hidden = false,
  overlay = false,
  state,
  onState,
  session,
  mode,
  runnerPath,
  onClose,
  refreshKey,
  onAddToChat,
  onQuickOpen,
  shortcuts,
  scripts = [],
  scriptsError,
  scriptKeys,
  scriptRuns = {},
  onRunScript,
}: {
  /** Kept mounted but out of sight (a split pane that isn't active), so terminals keep their screen. */
  hidden?: boolean;
  /** Lie over the conversation instead of beside it (narrow split panes). */
  overlay?: boolean;
  state: PanelState;
  onState: (update: (s: PanelState) => PanelState) => void;
  session: Session;
  mode: "local" | "cloud";
  runnerPath: string;
  onClose: () => void;
  refreshKey: string;
  onAddToChat: (text: string) => void;
  onQuickOpen: () => void;
  /** The keys for quick open and reopen, for menu hints ("" when turned off). */
  shortcuts: { quickOpen: string; reopen: string };
  /** The project's scripts (lemonlime.json), and what's wrong with the file if it couldn't be read. */
  scripts?: Script[];
  scriptsError?: string | undefined;
  /** The keys of a script shortcut, for menu hints. */
  scriptKeys?: (id: ScriptKeybinding) => string;
  /** Runs asked for, by tab id (see TerminalPanel's `run`). */
  scriptRuns?: Record<string, number>;
  onRunScript?: (script: Script) => void;
}) {
  const aside = useRef<HTMLElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => loadPanelWidth());
  // The room beside the sidebar, for the conversation and this panel together.
  const [available, setAvailable] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const parent = aside.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailable(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  // In a narrow pane the panel covers the conversation, leaving a sliver of it showing.
  const shownWidth = overlay ? Math.max(Math.min(width, available - 48), Math.min(available, 280)) : clampPanel(width, available);
  const compact = shownWidth < COMPACT_BELOW;

  const active = activeTab(state);
  const select = (id: string) => onState(s => ({ ...s, active: id }));
  // Keep the active tab in view when the strip scrolls.
  useEffect(() => {
    tablist.current?.querySelector(`[data-tab="${CSS.escape(active)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, state.tabs.length]);

  // Shell names and titles, as each terminal reports them.
  const [termInfo, setTermInfo] = useState<Record<string, { name?: string; title?: string }>>({});
  const setInfo = (id: string, patch: { name?: string; title?: string }) =>
    setTermInfo(m =>
      m[id]?.name === (patch.name ?? m[id]?.name) && m[id]?.title === (patch.title ?? m[id]?.title) ? m : { ...m, [id]: { ...m[id], ...patch } },
    );
  // Terminals stay mounted once opened, so switching tabs never drops their screen.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(isBuiltIn(active) ? [] : [active]));
  useEffect(() => {
    if (!isBuiltIn(active)) setMounted(m => (m.has(active) ? m : new Set([...m, active])));
  }, [active]);

  const close = (tab: PanelTab) => {
    if (tab.kind === "terminal") closeTerminal(session.connection, tab.terminal);
    setMounted(m => {
      const next = new Set(m);
      next.delete(tab.id);
      return next;
    });
    onState(s => closeTab(s, tab.id));
  };
  const addTerminal = () => onState(s => newTerminal(s) ?? s);
  // An address to open in the browser tab (from a terminal link, a script's preview); `n` makes each one count.
  const [browse, setBrowse] = useState<{ url: string; n: number } | null>(null);
  const openInBrowser = (url: string) => {
    setBrowse(b => ({ url, n: (b?.n ?? 0) + 1 }));
    select("browser");
  };
  const openFileAt = (path: string, line?: number) => onState(s => openFile(s, path, line));
  // A script with a preview address: open it in the browser tab once it answers (on this
  // computer), or straight away through the tunnel (elsewhere, where it can't be checked).
  const previewWait = useRef<AbortController | null>(null);
  useEffect(() => () => previewWait.current?.abort(), []);
  const openScriptPreview = (url: string) => {
    previewWait.current?.abort();
    if (mode !== "local") return openInBrowser(url);
    const ctl = new AbortController();
    previewWait.current = ctl;
    void (async () => {
      const until = Date.now() + PREVIEW_WAIT_MS;
      while (!ctl.signal.aborted && Date.now() < until) {
        try {
          await fetch(url, { mode: "no-cors", signal: ctl.signal, cache: "no-store" });
          break;
        } catch {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ctl.signal.aborted) openInBrowser(url);
    })();
  };
  const scriptKeyHint = (s: Script) => {
    const keys = s.keybinding && scriptKeys ? scriptKeys(s.keybinding) : "";
    return keys ? { hint: keyCaps(keys).join("") } : {};
  };
  const scriptItems =
    scripts.length > 0 ? (
      <>
        <MenuLabel>Project scripts</MenuLabel>
        {scripts.map(sc => {
          const Icon = scriptIcon(sc.icon);
          return (
            <MenuItem key={sc.id} icon={<Icon />} onSelect={() => onRunScript?.(sc)} {...scriptKeyHint(sc)}>
              {sc.name}
            </MenuItem>
          );
        })}
      </>
    ) : null;
  const atTerminalLimit = terminalCount(state) >= MAX_TERMINALS;

  // How many times the agent changed each file, so an open file reloads after a change.
  const versions = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of session.events) if (e.type === "file_diff") m.set(e.path, (m.get(e.path) ?? 0) + 1);
    return m;
  }, [session.events]);
  const changed = versions.size;

  // Left and Right move between tabs, like any tab list.
  const allIds = [...(Object.keys(BUILT_IN) as BuiltInTab[]), ...state.tabs.map(t => t.id)];
  const onTabKey = (e: KeyboardEvent) => {
    const at = allIds.indexOf(active);
    let to = -1;
    if (e.key === "ArrowRight") to = (at + 1) % allIds.length;
    else if (e.key === "ArrowLeft") to = (at - 1 + allIds.length) % allIds.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = allIds.length - 1;
    else if ((e.key === "Delete" || e.key === "Backspace") && !isBuiltIn(active)) {
      const tab = state.tabs.find(t => t.id === active);
      if (tab) close(tab);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    const id = allIds[to]!;
    select(id);
    requestAnimationFrame(() => tablist.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus());
  };

  // Drag a tab onto another to put it there.
  const dragging = useRef<string | null>(null);

  const tabButton = (id: string, label: string, icon: ReactNode, extra?: ReactNode, iconOnly = false) => {
    const on = active === id;
    const button = (
      <button
        type="button"
        role="tab"
        data-tab={id}
        aria-selected={on}
        aria-label={iconOnly ? label : undefined}
        tabIndex={on ? 0 : -1}
        onClick={() => select(id)}
        className={cx(
          "inline-flex h-[30px] max-w-[180px] min-w-0 items-center gap-1.5 rounded-lg px-2 text-[14px] font-medium",
          on ? "bg-cream-deep text-ink" : "text-ink-soft hover:bg-cream-deep hover:text-ink",
        )}
      >
        {icon}
        {!iconOnly && <span className="min-w-0 truncate">{label}</span>}
        {extra}
      </button>
    );
    return iconOnly ? (
      <Tip label={label} side="bottom">
        {button}
      </Tip>
    ) : (
      button
    );
  };

  return (
    <aside
      ref={aside}
      aria-label="Thread panel"
      style={{ width: shownWidth }}
      className={cx(
        "shrink-0 flex-col border-l border-line bg-cream",
        hidden ? "hidden" : "flex",
        overlay ? "absolute top-10 right-0 bottom-0 z-20 shadow-pop" : "relative",
      )}
    >
      {!overlay && <PanelResizer width={shownWidth} available={available} onWidth={setWidth} />}
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pr-2 pl-3">
        <div
          ref={tablist}
          role="tablist"
          aria-label="Panel"
          onKeyDown={onTabKey}
          className="scroll-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {(Object.keys(BUILT_IN) as BuiltInTab[]).map(id => {
            const { label, icon: Icon } = BUILT_IN[id];
            const count = id === "changes" && changed > 0 ? changed : null;
            return (
              <span key={id} className="shrink-0">
                {tabButton(
                  id,
                  count ? `${label}, ${count} ${count === 1 ? "file" : "files"}` : label,
                  <Icon aria-hidden="true" className="size-3.5 shrink-0" />,
                  count && !compact ? <span className="text-ink-faint tabular-nums">{count}</span> : undefined,
                  compact,
                )}
              </span>
            );
          })}
          {state.tabs.length > 0 && <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line-strong" />}
          {state.tabs.map((tab, i) => {
            const label = tab.kind === "terminal" ? terminalLabel(tab, termInfo[tab.id]?.name, termInfo[tab.id]?.title) : fileName(tab.path);
            const Icon = tab.kind === "terminal" ? (tab.script ? scriptIcon(scripts.find(x => x.id === tab.script)?.icon) : SquareTerminal) : FileText;
            return (
              <span
                key={tab.id}
                draggable
                onDragStart={e => {
                  dragging.current = tab.id;
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={e => {
                  if (dragging.current && dragging.current !== tab.id) e.preventDefault();
                }}
                onDrop={e => {
                  e.preventDefault();
                  const from = dragging.current;
                  dragging.current = null;
                  if (from && from !== tab.id) onState(s => moveTab(s, from, i));
                }}
                onDragEnd={() => (dragging.current = null)}
                onAuxClick={e => {
                  if (e.button === 1) close(tab);
                }}
                title={tab.kind === "file" ? tab.path : label}
                className="group/tab relative flex shrink-0 items-center"
              >
                {tabButton(tab.id, label, <Icon aria-hidden="true" className="size-3.5 shrink-0" />, <span aria-hidden="true" className="w-4 shrink-0" />)}
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  tabIndex={-1}
                  onClick={() => close(tab)}
                  className={cx(
                    "absolute right-1.5 inline-flex size-5 items-center justify-center rounded-md text-ink-faint hover:bg-cream-hover hover:text-ink",
                    active === tab.id ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
        {(scripts.length > 0 || scriptsError) && onRunScript && (
          <Menu
            align="end"
            className="max-w-[20rem]"
            trigger={
              <button
                type="button"
                aria-label="Run a project script"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep data-[popup-open]:bg-cream-deep"
              >
                <Play aria-hidden="true" className="size-4" />
              </button>
            }
          >
            {scriptItems}
            {scriptsError && (
              <p role="alert" className="max-w-[18rem] px-2.5 py-1.5 text-[13px] text-danger">
                {scriptsError}
              </p>
            )}
          </Menu>
        )}
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              aria-label="Open a terminal or file"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep data-[popup-open]:bg-cream-deep"
            >
              <Plus aria-hidden="true" className="size-4" />
            </button>
          }
        >
          <MenuItem icon={<SquareTerminal />} disabled={atTerminalLimit} onSelect={addTerminal} {...(atTerminalLimit ? { hint: `${MAX_TERMINALS} open` } : {})}>
            New terminal
          </MenuItem>
          <MenuItem icon={<FileSearch />} onSelect={onQuickOpen} {...(shortcuts.quickOpen ? { hint: keyCaps(shortcuts.quickOpen).join("") } : {})}>
            Open a file…
          </MenuItem>
          {scriptItems && onRunScript && (
            <>
              <MenuSeparator />
              {scriptItems}
            </>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<History />}
            disabled={state.closed.length === 0}
            onSelect={() => window.dispatchEvent(new Event("lemonlime:reopen-tab"))}
            {...(shortcuts.reopen ? { hint: keyCaps(shortcuts.reopen).join("") } : {})}
          >
            Reopen closed tab
          </MenuItem>
        </Menu>
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {active === "changes" && (
        <ReviewPanel
          connection={session.connection}
          refreshKey={refreshKey}
          onAddToChat={onAddToChat}
          onOpenFile={path => openFileAt(path)}
          fallback={<ChangesList events={session.events} />}
        />
      )}
      {active === "side" && <SideChatPanel side={session.side} connected={session.state === "live"} />}
      {active === "browser" && (
        <PreviewPanel
          events={session.events}
          mode={mode}
          connection={session.connection}
          onFindFile={onQuickOpen}
          findFileKeys={shortcuts.quickOpen ? keyCaps(shortcuts.quickOpen) : []}
          open={browse}
          onOfferPort={session.state === "live" ? session.offerPreview : undefined}
          {...(runnerPath ? { runnerPath } : {})}
        />
      )}
      {state.tabs.map(tab => {
        if (tab.kind === "file") {
          return tab.id === active ? (
            <FileView
              key={tab.id}
              connection={session.connection}
              path={tab.path}
              version={versions.get(tab.path) ?? 0}
              line={tab.line}
              onMention={path => onAddToChat(`@${path} `)}
            />
          ) : null;
        }
        if (!mounted.has(tab.id)) return null;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={terminalLabel(tab, termInfo[tab.id]?.name, undefined)}
            className={cx("min-h-0 flex-1 flex-col", tab.id === active ? "flex" : "hidden")}
          >
            <TerminalPanel
              connection={session.connection}
              terminal={tab.terminal}
              active={tab.id === active}
              onName={name => setInfo(tab.id, { name })}
              onTitle={title => setInfo(tab.id, { title })}
              onAddToChat={onAddToChat}
              onOpenUrl={openInBrowser}
              onOpenFile={openFileAt}
              script={tab.script}
              run={scriptRuns[tab.id] ?? 0}
              onRun={() => {
                const url = scripts.find(x => x.id === tab.script)?.previewUrl;
                if (url) openScriptPreview(url);
              }}
            />
          </div>
        );
      })}
    </aside>
  );
}

/**
 * The panel's left edge: drag to resize, with gentle snap points (320, 440, 640 and half
 * the window); arrow keys step between them, double-click goes back to the default.
 */
function PanelResizer({ width, available, onWidth }: { width: number; available: number; onWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number, save: boolean) => {
    onWidth(w);
    if (save) savePanelWidth(w);
  };
  const bounds = panelBounds(available);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onPointerDown={e => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
      }}
      onPointerMove={e => {
        if (drag.current) set(snapPanel(drag.current.w + (drag.current.x - e.clientX), available, window.innerWidth), false);
      }}
      onPointerUp={e => {
        if (drag.current) set(snapPanel(drag.current.w + (drag.current.x - e.clientX), available, window.innerWidth), true);
        drag.current = null;
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => set(clampPanel(PANEL_WIDTH.default, available), true)}
      onKeyDown={e => {
        if (e.key === "ArrowLeft") set(stepPanel(width, 1, available, window.innerWidth), true);
        else if (e.key === "ArrowRight") set(stepPanel(width, -1, available, window.innerWidth), true);
        else if (e.key === "Home") set(bounds.min, true);
        else if (e.key === "End") set(bounds.max, true);
        else return;
        e.preventDefault();
      }}
      className="absolute inset-y-0 -left-[3px] z-20 w-[6px] cursor-col-resize touch-none outline-none hover:bg-line-strong/60 focus-visible:bg-leaf/40 active:bg-line-strong"
    />
  );
}

/** Every file the agent changed in this thread, latest diff first. */
function ChangesList({ events }: { events: Session["events"] }) {
  const files = useMemo(() => {
    const latest = new Map<string, Extract<(typeof events)[number], { type: "file_diff" }>>();
    for (const e of events) if (e.type === "file_diff") latest.set(e.path, e);
    return [...latest.values()].reverse();
  }, [events]);
  const [open, setOpen] = useState<string | null>(null);
  const shown = files.find(f => f.path === open);
  return (
    <div role="tabpanel" aria-label="Changes" className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
            Files the agent changes show up here after each turn.
          </p>
        ) : shown ? (
          <div>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="mb-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[14px] text-ink-soft hover:bg-cream-deep"
            >
              ← All files
            </button>
            <DiffView path={shown.path} change={shown.change} diff={shown.diff} truncated={shown.truncated} />
          </div>
        ) : (
          <ul className="flex flex-col gap-px">
            {files.map(f => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setOpen(f.path)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-cream-deep"
                >
                  <span
                    className={cx("size-1.5 shrink-0 rounded-full", f.change === "added" ? "bg-lime-2" : f.change === "deleted" ? "bg-danger" : "bg-lemon-2")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{f.path}</span>
                  <span className="shrink-0 text-[13px] text-ink-faint">{f.change}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
