import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  AlarmClock,
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Columns2,
  Command,
  FolderGit2,
  FolderPlus,
  History,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  MessageSquareText,
  SlidersHorizontal,
  PanelLeft,
  PanelRight,
  Pin,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  SquarePen,
} from "lucide-react";
import { rankPalette, type PaletteItem, type PaletteSection } from "../lib/palette.ts";
import { IS_MAC, keyCaps, type ShortcutId } from "../lib/shortcuts.ts";
import { Highlighted } from "./Highlighted.tsx";
import { Kbd } from "./primitives.tsx";
import { cx } from "./ui.tsx";

const SECTION_LABEL: Record<PaletteSection, string> = {
  recent: "Recent",
  threads: "Threads",
  projects: "Projects",
  commands: "Commands",
  messages: "In messages",
};

const COMMAND_ICONS: Record<string, typeof Command> = {
  "new-thread": SquarePen,
  settings: SettingsIcon,
  "toggle-sidebar": PanelLeft,
  "right-panel": PanelRight,
  back: ArrowLeft,
  forward: ArrowRight,
  skills: BookOpen,
  plugins: Puzzle,
  automations: AlarmClock,
  "pin-thread": Pin,
  "archive-thread": Archive,
  "last-pinned": Pin,
  "prev-thread": ArrowLeft,
  "next-thread": ArrowRight,
  find: Search,
  "split-right": Columns2,
  "maximise-pane": Maximize2,
  "add-project": FolderPlus,
};

function iconFor(item: PaletteItem) {
  if (item.section === "threads") return MessageSquare;
  if (item.section === "messages") return MessageSquareText;
  if (item.id.startsWith("new-in:")) return SquarePen;
  if (item.id.startsWith("setting:")) return SlidersHorizontal;
  if (item.section === "projects") return FolderGit2;
  const id = item.id.replace(/^command:/, "");
  return COMMAND_ICONS[id] ?? (id.startsWith("settings:") ? SettingsIcon : id.startsWith("focus-pane-") ? LayoutGrid : Command);
}

/**
 * ⌘K: find a thread or project, or run any app command (type `>` for commands only).
 * Opens and closes instantly; focus goes back where it was when it closes.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  recents,
  onRun,
  keysOf,
  findInMessages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
  /** Recently picked item ids, newest first. */
  recents: readonly string[];
  /** `split`: ⌘↩ on a thread opens it beside the current one. */
  onRun: (item: PaletteItem, opts: { split?: boolean }) => void;
  /** The keys a shortcut has now ("" when turned off). */
  keysOf: (id: ShortcutId) => string;
  /** Messages in threads that match what's typed (the "In messages" group). */
  findInMessages?: (query: string) => PaletteItem[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
  }, [open]);

  const groups = useMemo(() => {
    if (!open) return [];
    const found = findInMessages && !query.trimStart().startsWith(">") ? findInMessages(query.trim()) : [];
    return rankPalette(found.length ? [...items, ...found] : items, query, recents);
  }, [open, items, query, recents, findInMessages]);
  const flat = useMemo(() => groups.flatMap(g => g.items.map(r => r.item)), [groups]);
  useEffect(() => setActive(0), [query]);
  const current = Math.min(active, Math.max(0, flat.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  const run = (item: PaletteItem | undefined, split = false) => {
    if (!item) return;
    onOpenChange(false);
    // After the dialog has closed and given focus back, so the command can move it on.
    requestAnimationFrame(() => onRun(item, { split }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const move = (to: number) => {
      e.preventDefault();
      if (flat.length) setActive((to + flat.length) % flat.length);
    };
    if (e.key === "ArrowDown") move(current + 1);
    else if (e.key === "ArrowUp") move(current - 1);
    else if (e.key === "Home" && e.ctrlKey) move(0);
    else if (e.key === "End" && e.ctrlKey) move(flat.length - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[current];
      run(item, item?.section === "threads" && (IS_MAC ? e.metaKey : e.ctrlKey));
    }
  };

  let index = -1;
  return (
    <Dialog.Root open={open} onOpenChange={o => onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/20" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={returnTo}
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(560px,72vh)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-paper text-ink shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Search threads and commands</Dialog.Title>
          <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-4">
            <Search aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
            <input
              ref={input}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search threads, messages and settings, or type > for commands"
              aria-label="Search threads, projects, messages, settings and commands"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-activedescendant={flat.length ? optionId(current) : undefined}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-faint"
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
            {flat.length === 0 && <p className="px-3 py-6 text-center text-[14px] text-ink-soft">Nothing matches “{query.replace(/^\s*>/, "").trim()}”.</p>}
            {groups.map(g => (
              <div key={g.section} role="group" aria-labelledby={`${listId}-${g.section}`} className="pb-1">
                <p id={`${listId}-${g.section}`} className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[13px] font-medium text-ink-faint">
                  {g.section === "recent" && <History aria-hidden="true" className="size-3.5" />}
                  {SECTION_LABEL[g.section]}
                </p>
                {g.items.map(({ item, match }) => {
                  const i = ++index;
                  const Icon = iconFor(item);
                  const keys = item.shortcut ? keysOf(item.shortcut) : "";
                  return (
                    <div
                      key={item.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === current}
                      onMouseMove={() => i !== current && setActive(i)}
                      onClick={() => run(item)}
                      className={cx("flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-[14px]", i === current && "bg-cream-deep")}
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
                      {item.section === "messages" ? (
                        <>
                          {/* What was said leads; whose thread it was follows, shorter. */}
                          <span className="min-w-0 flex-1 truncate">
                            <Highlighted text={item.label} positions={match.positions} />
                          </span>
                          {item.detail && <span className="max-w-[38%] min-w-0 shrink-0 truncate text-[13px] text-ink-faint">{item.detail}</span>}
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 shrink truncate">
                            <Highlighted text={item.label} positions={match.positions} />
                          </span>
                          {item.detail && <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint">{item.detail}</span>}
                          {!item.detail && <span className="flex-1" />}
                        </>
                      )}
                      {item.trailing && <span className="shrink-0 text-[13px] text-ink-faint tabular-nums">{item.trailing}</span>}
                      {keys && (
                        <span className="flex shrink-0 gap-1">
                          {keyCaps(keys).map(k => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-[13px] text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              Move
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↩</Kbd>
              Open
            </span>
            {flat[current]?.section === "threads" && (
              <span className="inline-flex items-center gap-1.5">
                <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>↩</Kbd>
                Open in split
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Kbd>&gt;</Kbd>
              Commands only
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5">
              <Kbd>Esc</Kbd>
              Close
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
