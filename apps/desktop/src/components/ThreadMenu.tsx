import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Columns2,
  Copy,
  CloudUpload,
  GitBranch,
  FolderOpen,
  GitFork,
  GitPullRequest,
  Laptop,
  MailCheck,
  MailOpen,
  PencilLine,
  Pin,
  PinOff,
  Shrink,
  Trash2,
} from "lucide-react";
import { threadMenuGroups, type ThreadMenuEntry, type ThreadMenuId, type ThreadMenuInput } from "../lib/threadMenu.ts";
import { ContextMenu, Menu, MenuItem, MenuSeparator } from "./primitives.tsx";
import { toast } from "./Toaster.tsx";
import { cx } from "./ui.tsx";

/** What a place can do to the thread; a missing handler leaves its item out. */
export interface ThreadMenuHandlers {
  /** Start renaming it here (an inline field). */
  rename?: () => void;
  pin?: (pin: boolean) => void;
  unread?: (unread: boolean) => void;
  split?: () => void;
  fork?: () => void;
  openFolder?: () => void;
  /** View the pull request, or open one (see `pullRequest` in the state). */
  pullRequest?: () => void;
  compact?: () => void;
  move?: () => void;
  archive?: (archive: boolean) => void;
  /** Asks first. */
  remove?: () => void;
}

export type ThreadMenuState = Omit<ThreadMenuInput, "can">;

export interface ThreadMenuProps {
  thread: { title: string; branch: string };
  state: ThreadMenuState;
  actions: ThreadMenuHandlers;
  /** Items only this place has (the header's sign-in and computer access), before Archive. */
  extra?: ReactNode;
}

const HANDLER: Record<Exclude<ThreadMenuId, "copy-name" | "copy-branch">, keyof ThreadMenuHandlers> = {
  rename: "rename",
  pin: "pin",
  unread: "unread",
  split: "split",
  fork: "fork",
  "open-folder": "openFolder",
  "pull-request": "pullRequest",
  compact: "compact",
  move: "move",
  archive: "archive",
  remove: "remove",
};

function icon(e: ThreadMenuEntry, s: ThreadMenuState): ReactNode {
  switch (e.id) {
    case "rename":
      return <PencilLine />;
    case "pin":
      return s.pinned ? <PinOff /> : <Pin />;
    case "unread":
      return s.unread ? <MailCheck /> : <MailOpen />;
    case "split":
      return <Columns2 />;
    case "fork":
      return <GitFork />;
    case "copy-name":
      return <Copy />;
    case "copy-branch":
      return <GitBranch />;
    case "open-folder":
      return <FolderOpen />;
    case "pull-request":
      return <GitPullRequest />;
    case "compact":
      return <Shrink />;
    case "move":
      return s.mode === "local" ? <CloudUpload /> : <Laptop />;
    case "archive":
      return s.archived ? <ArchiveRestore /> : <Archive />;
    case "remove":
      return <Trash2 />;
  }
}

function copy(text: string, what: string) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast({ title: `Copied the ${what}` }))
    .catch(() => toast({ title: `Couldn't copy the ${what}`, tone: "error" }));
}

/** The items, grouped with separators; destructive ones last. */
export function ThreadMenuItems({ thread, state, actions, extra }: ThreadMenuProps) {
  const can = new Set<ThreadMenuId>(
    (Object.entries(HANDLER) as [ThreadMenuId, keyof ThreadMenuHandlers][]).filter(([, h]) => actions[h] !== undefined).map(([id]) => id),
  );
  const groups = threadMenuGroups({ ...state, can });
  const run = (id: ThreadMenuId) => {
    if (id === "copy-name") return copy(thread.title, "thread name");
    if (id === "copy-branch") return copy(thread.branch, "branch name");
    if (id === "pin") return actions.pin?.(!state.pinned);
    if (id === "unread") return actions.unread?.(!state.unread);
    if (id === "archive") return actions.archive?.(!state.archived);
    (actions[HANDLER[id]] as (() => void) | undefined)?.();
  };
  // The place's own items go just before the last group (Archive, Remove).
  const at = groups.length > 0 && groups[groups.length - 1]!.some(e => e.id === "archive" || e.id === "remove") ? groups.length - 1 : groups.length;
  return (
    <>
      {groups.map((g, gi) => (
        <Fragment key={g[0]!.id}>
          {gi === at && extra && (
            <>
              {gi > 0 && <MenuSeparator />}
              {extra}
            </>
          )}
          {gi > 0 && <MenuSeparator />}
          {g.map(e => (
            <MenuItem key={e.id} icon={icon(e, state)} disabled={e.disabled} hint={e.hint} danger={e.danger} onSelect={() => run(e.id)}>
              {e.label}
            </MenuItem>
          ))}
        </Fragment>
      ))}
      {at === groups.length && extra && (
        <>
          {groups.length > 0 && <MenuSeparator />}
          {extra}
        </>
      )}
    </>
  );
}

/** The ⋯ dropdown. */
export function ThreadMenu({ trigger, align = "end", ...props }: ThreadMenuProps & { trigger: ReactElement; align?: "start" | "end" }) {
  return (
    <Menu align={align} trigger={trigger}>
      <ThreadMenuItems {...props} />
    </Menu>
  );
}

/** The same menu on a right-click (or Shift+F10) anywhere in `children`. */
export function ThreadRightClickMenu({ children, disabled, ...props }: ThreadMenuProps & { children: ReactElement; disabled?: boolean }) {
  return (
    <ContextMenu menu={<ThreadMenuItems {...props} />} {...(disabled ? { disabled } : {})}>
      {children}
    </ContextMenu>
  );
}

/** What the app gives a thread's header for its menu (the header adds what needs the live session). */
export interface AppThreadMenu {
  pinned: boolean;
  unread: boolean;
  inSplit?: boolean;
  editor?: boolean;
  actions: Pick<ThreadMenuHandlers, "pin" | "unread" | "split" | "fork" | "archive">;
  onRename?: (title: string) => void;
}

/** Inline rename: Enter or leaving the field saves, Escape cancels. */
export function RenameField({ initial, onDone, className = "text-[14px]" }: { initial: string; onDone: (title: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title === null ? null : title.trim() || null);
  };
  return (
    <input
      ref={ref}
      value={value}
      maxLength={200}
      aria-label="Thread name"
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === "Enter") finish(value);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
      className={cx(
        "h-8 w-full min-w-0 rounded-lg border border-line-strong bg-paper px-2 text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf",
        className,
      )}
    />
  );
}
