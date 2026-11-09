import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Ellipsis, File, FileCode2, FileImage, FileText, Folder, FoldVertical, ListTree, Search } from "lucide-react";
import { FilesResponse, FolderResponse } from "@lemonlime/protocol";
import { getJson } from "../lib/composerData.ts";
import { fileKind, parentsOf, treeRows, type Listing } from "../lib/fileTree.ts";
import { KEYS, LIST_COLUMN, useFolded, useSideWidth } from "../lib/sideWidth.ts";
import type { Connection } from "../lib/useThreadSession.ts";
import { FileView } from "./FileView.tsx";
import { Menu, MenuChoice, MenuItem, MenuLabel, MenuSeparator } from "./primitives.tsx";
import { SideResizer } from "./SideResizer.tsx";
import { IconButton, Spinner, cx, rowFill } from "./ui.tsx";

/** What the Files tab remembers while the thread is open (the panel keeps it as tabs switch). */
export interface FilesState {
  /** The file shown beside the tree. */
  selected: string | null;
  /** Open folders. */
  open: string[];
}
export const emptyFiles = (): FilesState => ({ selected: null, open: [] });

/**
 * The thread panel's Files tab: the thread's folder as a tree (ignored files left out), and
 * the picked file beside it. The tree can be hidden, moved to either side and resized.
 */
export function FilesPanel({
  connection,
  state,
  onState,
  refreshKey,
  versions,
  onMention,
  onQuickOpen,
  quickOpenKeys,
}: {
  connection: Connection | null;
  state: FilesState;
  onState: (update: (s: FilesState) => FilesState) => void;
  /** Changes after each turn, so new and deleted files show up. */
  refreshKey: string;
  /** Changes whenever the agent changes a file. */
  versions: ReadonlyMap<string, number>;
  onMention: (path: string) => void;
  onQuickOpen: () => void;
  quickOpenKeys: string;
}) {
  const [treeHidden, setTreeHidden] = useFolded(KEYS.fileTreeHidden);
  const [treeLeft, setTreeLeft] = useFolded(KEYS.fileTreeLeft);
  const [width, setWidth] = useSideWidth(KEYS.fileTree, LIST_COLUMN);
  const [listings, setListings] = useState<Map<string, Listing>>(() => new Map());
  const [missing, setMissing] = useState(false);
  const [filter, setFilter] = useState("");
  const [matches, setMatches] = useState<string[] | null>(null);
  const open = useMemo(() => new Set(state.open), [state.open]);
  const conn = useRef(connection);
  conn.current = connection;
  const openNow = useRef(state.open);
  openNow.current = state.open;

  const load = useCallback(async (dir: string) => {
    const c = conn.current;
    if (!c) return;
    setListings(m => new Map(m).set(dir, m.get(dir) ?? "loading"));
    try {
      const r = FolderResponse.safeParse(await getJson(c, `/folder?dir=${encodeURIComponent(dir)}`));
      setListings(m => new Map(m).set(dir, r.success ? r.data.entries : { error: "The folder couldn't be read." }));
    } catch (err) {
      // A runner from before the file tree answers 404.
      if (err instanceof Error && err.message === "HTTP 404") setMissing(true);
      setListings(m => new Map(m).set(dir, { error: "The folder couldn't be read." }));
    }
  }, []);

  // The top folder and every open one; again after each turn.
  useEffect(() => {
    if (!connection) return;
    setMissing(false);
    void load("");
    // Only on connecting and after turns: opening a folder loads it itself.
    for (const dir of openNow.current) void load(dir);
  }, [connection, refreshKey, load]);

  // Typing in the filter searches the whole folder, by name.
  useEffect(() => {
    const q = filter.trim();
    if (!q || !connection) return setMatches(null);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      getJson(connection, `/files?q=${encodeURIComponent(q)}&limit=100`, ctl.signal)
        .then(raw => {
          const r = FilesResponse.safeParse(raw);
          setMatches(r.success ? r.data.files : []);
        })
        .catch(() => undefined);
    }, 80);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [filter, connection]);

  const toggle = (dir: string) => {
    const opening = !open.has(dir);
    onState(s => ({ ...s, open: opening ? [...s.open, dir] : s.open.filter(d => d !== dir && !d.startsWith(`${dir}/`)) }));
    if (opening && !Array.isArray(listings.get(dir))) void load(dir);
  };
  const pick = (path: string) => {
    // Picking a search result opens the folders down to it, so the tree shows where it lives.
    const parents = parentsOf(path);
    onState(s => ({ selected: path, open: [...new Set([...s.open, ...parents])] }));
    for (const dir of parents) if (!Array.isArray(listings.get(dir))) void load(dir);
  };

  const rows = useMemo(() => treeRows(listings, open), [listings, open]);
  const top = listings.get("");

  const tree = (
    <div
      className={cx("relative flex shrink-0 flex-col bg-cream", treeLeft ? "order-first border-r border-line" : "order-last border-l border-line")}
      style={{ width, maxWidth: "70%" }}
    >
      <SideResizer
        edge={treeLeft ? "right" : "left"}
        width={width}
        bounds={LIST_COLUMN}
        label="Resize the file tree"
        onWidth={setWidth}
        onFold={() => setTreeHidden(true)}
      />
      <label className="m-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line-strong bg-paper px-2.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-leaf">
        <Search aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => e.key === "Escape" && filter && (e.stopPropagation(), setFilter(""))}
          placeholder="Filter files"
          aria-label="Filter files"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {matches ? (
          matches.length === 0 ? (
            <p className="px-2 py-2 text-[13px] text-ink-soft">No files match.</p>
          ) : (
            <ul aria-label="Matching files" className="flex flex-col gap-px">
              {matches.map(path => (
                <li key={path}>
                  <button
                    type="button"
                    onClick={() => pick(path)}
                    aria-current={state.selected === path ? "true" : undefined}
                    className={cx("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]", rowFill(state.selected === path))}
                  >
                    <FileIcon name={path} />
                    <span className="min-w-0 flex-1 truncate">{path.split("/").at(-1)}</span>
                    <span className="max-w-[45%] shrink truncate text-[12px] text-ink-faint">{parentsOf(path).at(-1) ?? ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : top === undefined || top === "loading" ? (
          <div className="flex justify-center py-6 text-ink-faint">
            <Spinner />
          </div>
        ) : !Array.isArray(top) ? (
          <p className="px-2 py-2 text-[13px] text-ink-soft">{top.error}</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-[13px] text-ink-soft">This folder is empty.</p>
        ) : (
          <ul role="tree" aria-label="Files" className="flex flex-col gap-px">
            {rows.map(r => (
              <li key={r.path} role="none">
                <button
                  type="button"
                  role="treeitem"
                  aria-level={r.depth + 1}
                  aria-expanded={r.dir ? open.has(r.path) : undefined}
                  aria-selected={!r.dir && state.selected === r.path}
                  onClick={() => (r.dir ? toggle(r.path) : pick(r.path))}
                  title={r.path}
                  style={{ paddingLeft: 6 + r.depth * 14 }}
                  className={cx("flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px]", rowFill(!r.dir && state.selected === r.path))}
                >
                  {r.dir ? (
                    <ChevronRight aria-hidden="true" className={cx("size-3.5 shrink-0 text-ink-faint", open.has(r.path) && "rotate-90")} />
                  ) : (
                    <FileIcon name={r.name} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {r.loading && <Spinner className="size-3" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <div role="tabpanel" aria-label="Files" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2">
        <p className="min-w-0 flex-1 truncate px-1 text-[13px] text-ink-soft">{state.selected ?? "Files"}</p>
        <IconButton label="Collapse all folders" disabled={state.open.length === 0} onClick={() => onState(s => ({ ...s, open: [] }))}>
          <FoldVertical aria-hidden="true" />
        </IconButton>
        <IconButton
          label={treeHidden ? "Show file tree" : "Hide file tree"}
          aria-pressed={!treeHidden}
          onClick={() => setTreeHidden(!treeHidden)}
          className={cx(!treeHidden && "bg-cream-deep text-ink")}
        >
          <ListTree aria-hidden="true" />
        </IconButton>
        <Menu
          align="end"
          trigger={
            <IconButton label="File options">
              <Ellipsis aria-hidden="true" />
            </IconButton>
          }
        >
          <MenuItem icon={<Search />} onSelect={onQuickOpen} hint={quickOpenKeys}>
            Go to file
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<ListTree />} onSelect={() => setTreeHidden(!treeHidden)}>
            {treeHidden ? "Show file tree" : "Hide file tree"}
          </MenuItem>
          <MenuLabel>File tree position</MenuLabel>
          <MenuChoice
            value={treeLeft ? "left" : "right"}
            onChange={v => setTreeLeft(v === "left")}
            options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
          />
          <MenuSeparator />
          <MenuItem icon={<FoldVertical />} disabled={state.open.length === 0} onSelect={() => onState(s => ({ ...s, open: [] }))}>
            Collapse all folders
          </MenuItem>
        </Menu>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {missing ? (
            <Empty title="Update the runner to browse files" detail="This thread's runner is older than the file tree." />
          ) : !connection ? (
            <Empty title="Not connected" detail="Files show up once the thread is connected." />
          ) : state.selected ? (
            <FileView key={state.selected} connection={connection} path={state.selected} version={versions.get(state.selected) ?? 0} onMention={onMention} />
          ) : (
            <Empty title="Open files appear here" detail={treeHidden ? "Show the file tree to pick one." : "Pick a file in the tree."} />
          )}
        </div>
        {!treeHidden && connection && !missing && tree}
      </div>
    </div>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
      <Folder aria-hidden="true" className="mb-2 size-5 text-ink-faint" />
      <p className="text-[14px] text-ink">{title}</p>
      <p className="text-[13px] text-ink-soft">{detail}</p>
    </div>
  );
}

function FileIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  const Icon = kind === "code" ? FileCode2 : kind === "prose" ? FileText : kind === "image" ? FileImage : File;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />;
}
