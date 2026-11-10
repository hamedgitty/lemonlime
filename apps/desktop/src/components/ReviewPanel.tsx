import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FileText,
  Folder,
  GitCommitHorizontal,
  MessageSquarePlus,
  RotateCw,
  Rows3,
  SlidersHorizontal,
  UnfoldVertical,
  X,
} from "lucide-react";
import type { DiffHunk, GitDiffResponse, ReviewFile } from "@lemonlime/protocol";
import type { Connection } from "../lib/useThreadSession.ts";
import {
  fetchGitDiff,
  hiddenBefore,
  numberHunk,
  quoteLines,
  ReviewUnavailable,
  splitPath,
  splitRows,
  type DiffRequest,
  type ReviewLine,
} from "../lib/review.ts";
import { buildFileTree, diffSides, highlightedDiffLines, isTestFile, type FileTreeNode } from "../lib/diffView.ts";
import { highlightDiffSides } from "../lib/diffHighlighter.ts";
import { languageFor } from "../lib/filePreview.ts";
import { render as renderHighlighted } from "../lib/markdownHighlight.tsx";
import { Menu, MenuCheck, MenuChoice, MenuLabel, MenuSeparator, Tip } from "./primitives.tsx";
import { Button, Spinner, cx } from "./ui.tsx";

type Scope = { scope: "branch" } | { scope: "uncommitted" } | { scope: "commit"; commit: string };
type Layout = "unified" | "split";

const LAYOUT_KEY = "lemonlime:review-layout";
const VIEW_KEY = "lemonlime:review-view";
const MORE_CONTEXT = 20;
const WHOLE_FILE = 100_000;
/** Files open at first when there are this few; each draws only once it scrolls into view. */
const AUTO_OPEN_FILES = 60;
/** A single file with more changed lines than this starts closed. */
const AUTO_OPEN_LINES = 1500;
/** Roughly one diff line's height, for the space a file takes before it is drawn. */
const LINE_PX = 19;

/** How the diffs show, remembered on this computer. */
interface ViewPrefs {
  hideTests: boolean;
  ignoreWhitespace: boolean;
  wrap: boolean;
  /** The list of changed files above the diffs. */
  tree: boolean;
}
const DEFAULT_VIEW: ViewPrefs = { hideTests: false, ignoreWhitespace: false, wrap: false, tree: true };

function loadView(): ViewPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Partial<Record<keyof ViewPrefs, unknown>>;
    const flag = (k: keyof ViewPrefs) => (typeof raw[k] === "boolean" ? (raw[k] as boolean) : DEFAULT_VIEW[k]);
    return { hideTests: flag("hideTests"), ignoreWhitespace: flag("ignoreWhitespace"), wrap: flag("wrap"), tree: flag("tree") };
  } catch {
    return DEFAULT_VIEW;
  }
}

const STATUS_LETTER: Record<ReviewFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", type_changed: "T" };
const STATUS_LABEL: Record<ReviewFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
};
const STATUS_STYLE: Record<ReviewFile["status"], string> = {
  added: "bg-lime-soft text-leaf-deep",
  modified: "bg-lemon-soft text-modified-ink",
  deleted: "bg-danger-soft text-danger",
  renamed: "bg-cream-deep text-ink-soft",
  copied: "bg-cream-deep text-ink-soft",
  type_changed: "bg-cream-deep text-ink-soft",
};

function loadLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

/**
 * The thread's changes as git sees them: the whole branch, what isn't committed yet, or
 * one commit. Lines picked in a diff can be added to the message being written.
 * Falls back to `fallback` (the agent's own diffs) when the runner can't answer.
 */
export function ReviewPanel({
  connection,
  refreshKey,
  onAddToChat,
  onOpenFile,
  fallback,
}: {
  connection: Connection | null;
  /** Changes whenever the files may have changed (a turn ended, the agent wrote a file). */
  refreshKey: string;
  onAddToChat: (text: string) => void;
  /** Open a file in its own tab (from a diff's header). */
  onOpenFile?: ((path: string) => void) | undefined;
  fallback: ReactNode;
}) {
  const [view, setViewState] = useState<ViewPrefs>(loadView);
  const setView = (patch: Partial<ViewPrefs>) =>
    setViewState(v => {
      const next = { ...v, ...patch };
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  const scroller = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<Scope>({ scope: "branch" });
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  };
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** Files fetched again with more context, by path. */
  const [wider, setWider] = useState<Record<string, { context: number; file: ReviewFile }>>({});
  const scopeKey = scope.scope === "commit" ? `commit:${scope.commit}` : scope.scope;
  const seq = useRef(0);
  const shownKey = useRef("");

  const load = useCallback(async () => {
    if (!connection) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const req: DiffRequest = {
        ...(scope.scope === "commit" ? { scope: "commit" as const, commit: scope.commit } : { scope: scope.scope }),
        ...(view.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      };
      const next = await fetchGitDiff(connection, req);
      if (mine !== seq.current) return;
      // First answer for this scope: open everything if the change is small.
      const key = `${next.scope}:${next.commit ?? ""}`;
      if (shownKey.current !== key) {
        shownKey.current = key;
        setOpen(
          next.files.length <= AUTO_OPEN_FILES ? new Set(next.files.filter(f => f.additions + f.deletions <= AUTO_OPEN_LINES).map(f => f.path)) : new Set(),
        );
      }
      setData(next);
      setWider({});
      setError(null);
      setUnavailable(false);
    } catch (err) {
      if (mine !== seq.current) return;
      if (err instanceof ReviewUnavailable) setUnavailable(true);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [connection, scope, view.ignoreWhitespace]);

  // Load on open, when the scope changes, and (debounced) when the files may have changed.
  useEffect(() => {
    const t = setTimeout(() => void load(), data ? 600 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey, scopeKey, view.ignoreWhitespace]);

  const widen = async (f: ReviewFile, context: number) => {
    if (!connection) return;
    try {
      const req: DiffRequest = {
        ...(scope.scope === "commit" ? { scope: "commit" as const, commit: scope.commit } : { scope: scope.scope }),
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        context,
        ...(view.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
      };
      const r = await fetchGitDiff(connection, req);
      const file = r.files.find(x => x.path === f.path);
      if (file) setWider(w => ({ ...w, [f.path]: { context, file } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const allFiles = useMemo(() => data?.files ?? [], [data]);
  const testCount = useMemo(() => allFiles.filter(f => isTestFile(f.path)).length, [allFiles]);
  const files = useMemo(() => (view.hideTests ? allFiles.filter(f => !isTestFile(f.path)) : allFiles), [allFiles, view.hideTests]);
  const tree = useMemo(() => buildFileTree(files), [files]);

  if (unavailable || !connection) return <>{fallback}</>;

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const commits = data?.commits ?? [];
  const scopeLabel =
    scope.scope === "branch"
      ? "All changes on this branch"
      : scope.scope === "uncommitted"
        ? "Not committed yet"
        : `Commit ${commits.find(c => c.sha === scope.commit)?.shortSha ?? scope.commit.slice(0, 7)}`;

  const jump = (path: string) => {
    setOpen(o => new Set(o).add(path));
    requestAnimationFrame(() => document.getElementById(fileAnchor(path))?.scrollIntoView({ block: "start" }));
  };
  const anyOpen = files.some(f => open.has(f.path));
  const toggleAll = () => setOpen(anyOpen ? new Set() : new Set(files.map(f => f.path)));
  const hiddenTests = view.hideTests ? testCount : 0;

  return (
    <div role="tabpanel" aria-label="Changes" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
        <Menu
          align="start"
          className="max-h-[60vh] min-w-[18rem] overflow-y-auto"
          trigger={
            <button
              type="button"
              className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 text-[14px] font-medium text-ink hover:bg-cream data-[popup-open]:bg-cream"
            >
              {scope.scope === "commit" ? <GitCommitHorizontal aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" /> : null}
              <span className="truncate">{scopeLabel}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
            </button>
          }
        >
          <MenuChoice
            closeOnClick
            value={scope.scope === "commit" ? "" : scope.scope}
            onChange={v => setScope({ scope: v as "branch" | "uncommitted" })}
            options={[
              { value: "branch", label: "All changes on this branch" },
              { value: "uncommitted", label: "Not committed yet" },
            ]}
          />
          {commits.length > 0 && (
            <>
              <MenuSeparator />
              <MenuLabel>One commit</MenuLabel>
              <MenuChoice
                closeOnClick
                value={scope.scope === "commit" ? scope.commit : ""}
                onChange={commit => setScope({ scope: "commit", commit })}
                options={commits.map(c => ({
                  value: c.sha,
                  label: (
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[13px] text-ink-faint">{c.shortSha}</span>
                      <span className="truncate">{c.subject}</span>
                    </span>
                  ),
                }))}
              />
            </>
          )}
        </Menu>
        <span className="flex-1" />
        {files.length > 0 && (
          <Tip label={anyOpen ? "Collapse all files" : "Expand all files"} side="bottom">
            <button
              type="button"
              aria-label={anyOpen ? "Collapse all files" : "Expand all files"}
              onClick={toggleAll}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink"
            >
              {anyOpen ? <ChevronsDownUp aria-hidden="true" className="size-3.5" /> : <ChevronsUpDown aria-hidden="true" className="size-3.5" />}
            </button>
          </Tip>
        )}
        <Menu
          align="end"
          trigger={
            <button
              type="button"
              aria-label="View options"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink data-[popup-open]:bg-cream-deep"
            >
              <SlidersHorizontal aria-hidden="true" className="size-3.5" />
            </button>
          }
        >
          <MenuCheck checked={view.tree} onChange={tree => setView({ tree })}>
            Show the file list
          </MenuCheck>
          <MenuCheck checked={view.wrap} onChange={wrap => setView({ wrap })}>
            Wrap long lines
          </MenuCheck>
          <MenuCheck checked={view.ignoreWhitespace} onChange={ignoreWhitespace => setView({ ignoreWhitespace })}>
            Ignore whitespace changes
          </MenuCheck>
          <MenuCheck checked={view.hideTests} onChange={hideTests => setView({ hideTests })}>
            Hide test files
          </MenuCheck>
        </Menu>
        <div role="radiogroup" aria-label="Diff layout" className="flex rounded-lg border border-line bg-cream-deep/60 p-0.5">
          {(
            [
              ["unified", "Unified", Rows3],
              ["split", "Side by side", Columns2],
            ] as const
          ).map(([value, label, Icon]) => (
            <Tip key={value} label={label} side="bottom">
              <button
                type="button"
                role="radio"
                aria-checked={layout === value}
                aria-label={label}
                onClick={() => setLayout(value)}
                className={cx(
                  "inline-flex size-7 items-center justify-center rounded-md",
                  layout === value ? "bg-paper text-ink shadow-[0_1px_2px_rgb(23_32_14/0.08)]" : "text-ink-soft hover:text-ink",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
              </button>
            </Tip>
          ))}
        </div>
        <Tip label="Refresh" side="bottom">
          <button
            type="button"
            aria-label="Refresh"
            onClick={() => void load()}
            className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink"
          >
            {loading ? <Spinner /> : <RotateCw aria-hidden="true" className="size-3.5" />}
          </button>
        </Tip>
      </div>

      {error && (
        <p role="alert" className="border-b border-danger/20 bg-danger-soft px-4 py-2 text-[13px] text-ink">
          {error}
        </p>
      )}

      {!data ? (
        <div className="flex flex-1 items-center justify-center text-[14px] text-ink-soft">{loading ? <Spinner /> : null}</div>
      ) : files.length === 0 ? (
        <div className="m-3 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
          <p>{hiddenTests > 0 ? "Only test files changed here." : scope.scope === "uncommitted" ? "Everything is committed." : "No changes here yet."}</p>
          {hiddenTests > 0 && (
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => setView({ hideTests: false })}>
              Show test files
            </Button>
          )}
        </div>
      ) : (
        <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-line px-2 py-2">
            <button
              type="button"
              aria-expanded={view.tree}
              onClick={() => setView({ tree: !view.tree })}
              className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ink-soft hover:bg-cream-deep"
            >
              <ChevronRight aria-hidden="true" className={cx("size-3.5 shrink-0 text-ink-faint", view.tree && "rotate-90")} />
              <span>
                {files.length + (data.moreFiles ?? 0)} {files.length + (data.moreFiles ?? 0) === 1 ? "file" : "files"}
              </span>
              <Counts additions={additions} deletions={deletions} />
            </button>
            {view.tree && (
              <ul aria-label="Changed files" className="mt-0.5 flex flex-col gap-px">
                <TreeRows
                  nodes={tree}
                  depth={0}
                  folded={folded}
                  onFold={path =>
                    setFolded(f => {
                      const n = new Set(f);
                      if (n.has(path)) n.delete(path);
                      else n.add(path);
                      return n;
                    })
                  }
                  onPick={jump}
                />
              </ul>
            )}
            {data.moreFiles > 0 && (
              <p className="px-2 pt-1 text-[13px] text-ink-soft">
                {data.moreFiles} more {data.moreFiles === 1 ? "file isn't" : "files aren't"} listed because the change is very large.
              </p>
            )}
            {hiddenTests > 0 && (
              <p className="flex items-center gap-2 px-2 pt-1 text-[13px] text-ink-soft">
                {hiddenTests} test {hiddenTests === 1 ? "file is" : "files are"} hidden.
                <button type="button" onClick={() => setView({ hideTests: false })} className="rounded-md px-1 font-medium text-ink hover:bg-cream-deep">
                  Show
                </button>
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 p-2">
            {files.map(f => {
              const shown = wider[f.path]?.file ?? f;
              return (
                <FileDiffCard
                  key={f.path}
                  file={shown}
                  layout={layout}
                  wrap={view.wrap}
                  root={scroller}
                  open={open.has(f.path)}
                  onToggle={() =>
                    setOpen(o => {
                      const n = new Set(o);
                      if (n.has(f.path)) n.delete(f.path);
                      else n.add(f.path);
                      return n;
                    })
                  }
                  context={wider[f.path]?.context ?? 3}
                  onWiden={context => void widen(f, context)}
                  onAddToChat={onAddToChat}
                  onOpenFile={onOpenFile && f.status !== "deleted" ? () => onOpenFile(f.path) : undefined}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The changed files as folders that fold, each file jumping to its diff. */
function TreeRows({
  nodes,
  depth,
  folded,
  onFold,
  onPick,
}: {
  nodes: FileTreeNode<ReviewFile>[];
  depth: number;
  folded: Set<string>;
  onFold: (path: string) => void;
  onPick: (path: string) => void;
}) {
  const indent = { paddingLeft: 8 + depth * 14 };
  return (
    <>
      {nodes.map(n =>
        n.kind === "dir" ? (
          <li key={`d:${n.path}`}>
            <button
              type="button"
              aria-expanded={!folded.has(n.path)}
              onClick={() => onFold(n.path)}
              style={indent}
              className="flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left hover:bg-cream-deep"
            >
              <ChevronRight aria-hidden="true" className={cx("size-3.5 shrink-0 text-ink-faint", !folded.has(n.path) && "rotate-90")} />
              <Folder aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 truncate font-mono text-[13px] text-ink-soft">{n.name}</span>
            </button>
            {!folded.has(n.path) && (
              <ul className="flex flex-col gap-px">
                <TreeRows nodes={n.children} depth={depth + 1} folded={folded} onFold={onFold} onPick={onPick} />
              </ul>
            )}
          </li>
        ) : (
          <li key={`f:${n.path}`}>
            <button
              type="button"
              onClick={() => onPick(n.path)}
              title={n.file.oldPath ? `${n.file.oldPath} → ${n.path}` : n.path}
              style={{ paddingLeft: indent.paddingLeft + 20 }}
              className="flex h-7 w-full items-center gap-2 rounded-lg pr-2 text-left hover:bg-cream-deep"
            >
              <StatusBadge status={n.file.status} />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{n.name}</span>
              <Counts additions={n.file.additions} deletions={n.file.deletions} binary={n.file.binary} />
            </button>
          </li>
        ),
      )}
    </>
  );
}

const fileAnchor = (path: string) => `review-file-${encodeURIComponent(path).replace(/%/g, "_")}`;

function StatusBadge({ status }: { status: ReviewFile["status"] }) {
  return (
    <span
      title={STATUS_LABEL[status]}
      className={cx("inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] font-mono text-[12px] font-semibold", STATUS_STYLE[status])}
    >
      <span aria-hidden="true">{STATUS_LETTER[status]}</span>
      <span className="sr-only">{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** The path with its folders shrinking first, so the file name stays readable. */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={cx("flex min-w-0 flex-1 items-baseline font-mono text-[13px]", className)}>
      {dir && <span className="min-w-0 shrink truncate text-ink-faint">{dir}</span>}
      <span className="max-w-full min-w-[3ch] shrink-0 truncate text-ink">{name}</span>
    </span>
  );
}

function Counts({ additions, deletions, binary }: { additions: number; deletions: number; binary?: boolean }) {
  if (binary) return <span className="shrink-0 text-[13px] text-ink-faint">Binary</span>;
  return (
    <span className="shrink-0 text-[13px] tabular-nums">
      <span className="text-diff-add-strong">
        <span aria-hidden="true">+</span>
        <span className="sr-only">added </span>
        {additions}
      </span>{" "}
      <span className="text-diff-del-strong">
        <span aria-hidden="true">−</span>
        <span className="sr-only">removed </span>
        {deletions}
      </span>
    </span>
  );
}

interface Picked {
  anchor: number;
  focus: number;
}

/** Draw a file once it comes within this far of the visible part of the list. */
const NEAR_VIEW = "800px 0px";

/** Becomes true once `ref` scrolls near the visible part of `root`, and stays true. */
function useSeen(ref: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && setSeen(true), { root: root.current, rootMargin: NEAR_VIEW });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, root, seen]);
  return seen;
}

/** Syntax colours for each diff line, worked out off the main thread once the file is drawn. */
function useDiffHighlight(path: string, lines: ReviewLine[], enabled: boolean): Map<ReviewLine, ReactNode> | null {
  const [shown, setShown] = useState<Map<ReviewLine, ReactNode> | null>(null);
  useEffect(() => {
    setShown(null);
    if (!enabled || !lines.length) return;
    const sides = diffSides(lines);
    if (!sides) return;
    let live = true;
    void highlightDiffSides(sides, languageFor(path)).then(r => {
      if (!live || !r) return;
      const nodes = highlightedDiffLines(lines, r.old ?? [], r.new ?? []);
      const out = new Map<ReviewLine, ReactNode>();
      let i = 0;
      for (const [line, hl] of nodes) out.set(line, renderHighlighted(hl, `l${i++}`));
      setShown(out);
    });
    return () => {
      live = false;
    };
  }, [path, lines, enabled]);
  return shown;
}

function FileDiffCard({
  file,
  layout,
  wrap,
  root,
  open,
  onToggle,
  context,
  onWiden,
  onAddToChat,
  onOpenFile,
}: {
  file: ReviewFile;
  layout: Layout;
  wrap: boolean;
  /** The scrolling list, to draw files only as they come into view. */
  root: RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggle: () => void;
  context: number;
  onWiden: (context: number) => void;
  onAddToChat: (text: string) => void;
  onOpenFile?: (() => void) | undefined;
}) {
  const card = useRef<HTMLElement>(null);
  const seen = useSeen(card, root);
  // Every line in order, so a picked range is a slice of this list.
  const numbered = useMemo(() => file.hunks.map(numberHunk), [file.hunks]);
  const flat = useMemo(() => numbered.flat(), [numbered]);
  const drawn = open && seen;
  const hl = useDiffHighlight(file.path, flat, drawn && !file.binary);
  const indexOf = useMemo(() => new Map(flat.map((l, i) => [l, i])), [flat]);
  const [picked, setPicked] = useState<Picked | null>(null);
  useEffect(() => setPicked(null), [file]);
  const range = picked ? [Math.min(picked.anchor, picked.focus), Math.max(picked.anchor, picked.focus)] : null;
  const isPicked = (l: ReviewLine | null) => {
    if (!l || !range) return false;
    const i = indexOf.get(l) ?? -1;
    return i >= range[0]! && i <= range[1]!;
  };
  const pick = (l: ReviewLine, extend: boolean) => {
    const i = indexOf.get(l);
    if (i === undefined) return;
    setPicked(p => (extend && p ? { anchor: p.anchor, focus: i } : p && p.anchor === i && p.focus === i ? null : { anchor: i, focus: i }));
  };
  const pickedLines = range ? flat.slice(range[0]!, range[1]! + 1) : [];
  const pickedLabel = (() => {
    const nums = pickedLines.map(l => l.newNo ?? l.oldNo).filter((n): n is number => n !== null);
    if (!nums.length) return "";
    const a = Math.min(...nums);
    const b = Math.max(...nums);
    return a === b ? `Line ${a}` : `Lines ${a}–${b}`;
  })();

  return (
    <section ref={card} id={fileAnchor(file.path)} aria-label={file.path} className="overflow-hidden rounded-xl border border-line bg-paper shadow-panel">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-paper px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-cream-deep"
        >
          <ChevronRight aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint", open && "rotate-90")} />
          <StatusBadge status={file.status} />
          <span className="flex min-w-0 flex-1 flex-col">
            <PathLabel path={file.path} />
            {file.oldPath && <span className="truncate font-mono text-[12px] text-ink-faint">from {file.oldPath}</span>}
          </span>
          <Counts additions={file.additions} deletions={file.deletions} binary={file.binary} />
        </button>
        {onOpenFile && (
          <Tip label="Open the file" side="bottom">
            <button
              type="button"
              aria-label="Open the file"
              onClick={onOpenFile}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-cream-deep hover:text-ink"
            >
              <FileText aria-hidden="true" className="size-3.5" />
            </button>
          </Tip>
        )}
        {open && !file.binary && file.hunks.length > 0 && context < WHOLE_FILE && (
          <Tip label="Show the whole file" side="bottom">
            <button
              type="button"
              aria-label="Show the whole file"
              onClick={() => onWiden(WHOLE_FILE)}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-cream-deep hover:text-ink"
            >
              <UnfoldVertical aria-hidden="true" className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      {open && picked && pickedLabel && (
        <div className="sticky top-[45px] z-10 flex items-center gap-2 border-b border-lemon-line bg-lemon-soft px-3 py-1.5 text-[13px] text-ink">
          <span className="min-w-0 flex-1 truncate">{pickedLabel} picked. Shift-click a line number to pick more.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onAddToChat(quoteLines(file.path, pickedLines));
              setPicked(null);
            }}
          >
            <MessageSquarePlus aria-hidden="true" className="size-3.5" />
            Add to chat
          </Button>
          <button
            type="button"
            aria-label="Clear the picked lines"
            onClick={() => setPicked(null)}
            className="inline-flex size-7 items-center justify-center rounded-md text-ink-soft hover:bg-ink/5 hover:text-ink"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      {open && !seen && (
        // Not near the view yet: hold its place, so the scrollbar and jumps stay right.
        <div aria-hidden="true" style={{ height: Math.min(4000, Math.max(1, flat.length) * LINE_PX + file.hunks.length * 24) }} />
      )}
      {drawn && (
        <div className="scroll-thin overflow-x-auto">
          {file.binary ? (
            <p className="px-4 py-3 text-[13px] text-ink-soft">Binary file, not shown.</p>
          ) : file.hunks.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-ink-soft">
              {file.truncated ? "This file's diff is too large to show here." : file.status === "renamed" ? "Renamed without changes." : "No line changes."}
            </p>
          ) : (
            <table className={cx("w-full border-collapse font-mono text-[12px] leading-[1.6]", (layout === "split" || wrap) && "table-fixed", hl && "md-code")}>
              {layout === "split" && (
                // Side by side: two equal halves; long lines wrap rather than push the other side away.
                <colgroup>
                  <col className="w-10" />
                  <col className="w-4" />
                  <col />
                  <col className="w-10" />
                  <col className="w-4" />
                  <col />
                </colgroup>
              )}
              {layout === "unified" && wrap && (
                <colgroup>
                  <col className="w-10" />
                  <col className="w-10" />
                  <col className="w-4" />
                  <col />
                </colgroup>
              )}
              <tbody>
                {file.hunks.map((h, hi) => (
                  <Fragment key={`${hi}:${h.header}`}>
                    <GapRow hunks={file.hunks} index={hi} layout={layout} onMore={() => onWiden(context + MORE_CONTEXT)} hunk={h} />
                    {layout === "unified"
                      ? numbered[hi]!.map((l, li) => <UnifiedRow key={li} line={l} picked={isPicked(l)} onPick={pick} wrap={wrap} code={hl?.get(l)} />)
                      : splitRows(numbered[hi]!).map((r, ri) => <SplitRowView key={ri} row={r} isPicked={isPicked} onPick={pick} hl={hl} />)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          {file.truncated && file.hunks.length > 0 && (
            <p className="border-t border-line bg-cream px-4 py-2 text-[13px] text-ink-soft">This diff was shortened because the file is large.</p>
          )}
        </div>
      )}
    </section>
  );
}

function GapRow({ hunks, index, layout, hunk, onMore }: { hunks: DiffHunk[]; index: number; layout: Layout; hunk: DiffHunk; onMore: () => void }) {
  const hidden = hiddenBefore(hunks, index);
  const section = hunk.header.replace(/^@@[^@]*@@\s?/, "");
  return (
    <tr className="bg-cream-deep/70 text-ink-faint">
      <td colSpan={layout === "unified" ? 4 : 6} className="px-2 py-0.5">
        <span className="flex items-center gap-2 font-sans text-[13px]">
          {hidden > 0 ? (
            <button
              type="button"
              onClick={onMore}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-soft hover:bg-cream-hover hover:text-ink"
            >
              <UnfoldVertical aria-hidden="true" className="size-3.5" />
              {hidden <= MORE_CONTEXT ? (
                `Show ${hidden} hidden ${hidden === 1 ? "line" : "lines"}`
              ) : (
                <>
                  Show {MORE_CONTEXT} more lines <span className="text-ink-faint">({hidden} hidden)</span>
                </>
              )}
            </button>
          ) : null}
          {section && <span className="min-w-0 truncate font-mono text-[12px]">{section}</span>}
        </span>
      </td>
    </tr>
  );
}

const LINE_BG = { add: "bg-diff-add", del: "bg-diff-del", context: "", note: "" } as const;
const LINE_FG = { add: "text-diff-add-strong", del: "text-diff-del-strong", context: "text-ink", note: "text-ink-faint italic" } as const;
const SIGN = { add: "+", del: "−", context: " ", note: " " } as const;

function LineNo({ n, line, picked, onPick }: { n: number | null; line: ReviewLine; picked: boolean; onPick: (l: ReviewLine, extend: boolean) => void }) {
  if (line.kind === "note") return <td className="w-10 border-r border-line/70" />;
  return (
    <td className={cx("w-10 border-r border-line/70 p-0 align-top", picked && "bg-lemon")}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Pick line ${n ?? ""}`}
        aria-pressed={picked}
        onClick={e => onPick(line, e.shiftKey)}
        className="block w-full cursor-pointer px-2 text-right text-ink-faint tabular-nums select-none hover:bg-lemon-soft hover:text-ink"
      >
        {n ?? " "}
      </button>
    </td>
  );
}

function UnifiedRow({
  line,
  picked,
  onPick,
  wrap,
  code,
}: {
  line: ReviewLine;
  picked: boolean;
  onPick: (l: ReviewLine, extend: boolean) => void;
  wrap: boolean;
  /** The line with syntax colours, once they're ready. */
  code?: ReactNode | undefined;
}) {
  return (
    <tr className={cx(LINE_BG[line.kind], picked && "outline-2 -outline-offset-2 outline-lemon-edge")}>
      <LineNo n={line.oldNo} line={line} picked={picked} onPick={onPick} />
      <LineNo n={line.newNo} line={line} picked={picked} onPick={onPick} />
      <td aria-hidden="true" className={cx("w-4 pl-1.5 align-top select-none", LINE_FG[line.kind])}>
        {SIGN[line.kind]}
      </td>
      <td className={cx("pr-3 align-top", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre", code ? "text-ink" : LINE_FG[line.kind])}>
        <span className="sr-only">{line.kind === "add" ? "Added: " : line.kind === "del" ? "Removed: " : ""}</span>
        {code ?? (line.text || " ")}
      </td>
    </tr>
  );
}

function SplitRowView({
  row,
  isPicked,
  onPick,
  hl,
}: {
  row: ReturnType<typeof splitRows>[number];
  isPicked: (l: ReviewLine | null) => boolean;
  onPick: (l: ReviewLine, extend: boolean) => void;
  hl: Map<ReviewLine, ReactNode> | null;
}) {
  const side = (l: ReviewLine | null, which: "left" | "right") => {
    if (!l) return <td colSpan={3} className={cx("bg-cream/60", which === "left" && "border-r border-line/70")} />;
    const picked = isPicked(l);
    const n = which === "left" ? l.oldNo : l.newNo;
    return (
      <>
        <LineNo n={n} line={l} picked={picked} onPick={onPick} />
        <td aria-hidden="true" className={cx("w-4 pl-1.5 align-top select-none", LINE_BG[l.kind], LINE_FG[l.kind])}>
          {SIGN[l.kind]}
        </td>
        <td
          className={cx(
            "pr-3 align-top break-all whitespace-pre-wrap",
            LINE_BG[l.kind],
            hl?.has(l) ? "text-ink" : LINE_FG[l.kind],
            which === "left" && "border-r border-line/70",
            picked && "outline-2 -outline-offset-2 outline-lemon-edge",
          )}
        >
          <span className="sr-only">{l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}</span>
          {hl?.get(l) ?? (l.text || " ")}
        </td>
      </>
    );
  };
  return (
    <tr>
      {side(row.left, "left")}
      {side(row.right, "right")}
    </tr>
  );
}
