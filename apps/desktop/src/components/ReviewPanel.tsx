import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Columns2, GitCommitHorizontal, MessageSquarePlus, RotateCw, Rows3, UnfoldVertical, X } from "lucide-react";
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
import { Menu, MenuChoice, MenuLabel, MenuSeparator, Tip } from "./primitives.tsx";
import { Button, Spinner, cx } from "./ui.tsx";

type Scope = { scope: "branch" } | { scope: "uncommitted" } | { scope: "commit"; commit: string };
type Layout = "unified" | "split";

const LAYOUT_KEY = "lemonlime:review-layout";
const MORE_CONTEXT = 20;
const WHOLE_FILE = 100_000;
/** Open every file at first when the change is this small. */
const AUTO_OPEN_FILES = 6;
const AUTO_OPEN_LINES = 400;

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
  modified: "bg-lemon-soft text-[#6b5a00]",
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
  fallback,
}: {
  connection: Connection | null;
  /** Changes whenever the files may have changed (a turn ended, the agent wrote a file). */
  refreshKey: string;
  onAddToChat: (text: string) => void;
  fallback: ReactNode;
}) {
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
      const req: DiffRequest = scope.scope === "commit" ? { scope: "commit", commit: scope.commit } : { scope: scope.scope };
      const next = await fetchGitDiff(connection, req);
      if (mine !== seq.current) return;
      // First answer for this scope: open everything if the change is small.
      const key = `${next.scope}:${next.commit ?? ""}`;
      if (shownKey.current !== key) {
        shownKey.current = key;
        const lines = next.files.reduce((n, f) => n + f.additions + f.deletions, 0);
        setOpen(next.files.length <= AUTO_OPEN_FILES && lines <= AUTO_OPEN_LINES ? new Set(next.files.map(f => f.path)) : new Set());
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
  }, [connection, scope]);

  // Load on open, when the scope changes, and (debounced) when the files may have changed.
  useEffect(() => {
    const t = setTimeout(() => void load(), data ? 600 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey, scopeKey]);

  const widen = async (f: ReviewFile, context: number) => {
    if (!connection) return;
    try {
      const req: DiffRequest = {
        ...(scope.scope === "commit" ? { scope: "commit" as const, commit: scope.commit } : { scope: scope.scope }),
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        context,
      };
      const r = await fetchGitDiff(connection, req);
      const file = r.files.find(x => x.path === f.path);
      if (file) setWider(w => ({ ...w, [f.path]: { context, file } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (unavailable || !connection) return <>{fallback}</>;

  const files = data?.files ?? [];
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
        <p className="m-3 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
          {scope.scope === "uncommitted" ? "Everything is committed." : "No changes here yet."}
        </p>
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-line px-2 py-2">
            <p className="flex items-center gap-2 px-2 pb-1 text-[13px] text-ink-soft">
              <span>
                {files.length + (data.moreFiles ?? 0)} {files.length + (data.moreFiles ?? 0) === 1 ? "file" : "files"}
              </span>
              <Counts additions={additions} deletions={deletions} />
            </p>
            <ul aria-label="Changed files" className="flex flex-col gap-px">
              {files.map(f => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => jump(f.path)}
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-cream-deep"
                  >
                    <StatusBadge status={f.status} />
                    <PathLabel path={f.path} />
                    <Counts additions={f.additions} deletions={f.deletions} binary={f.binary} />
                  </button>
                </li>
              ))}
            </ul>
            {data.moreFiles > 0 && (
              <p className="px-2 pt-1 text-[13px] text-ink-soft">
                {data.moreFiles} more {data.moreFiles === 1 ? "file isn't" : "files aren't"} listed because the change is very large.
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
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
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

function FileDiffCard({
  file,
  layout,
  open,
  onToggle,
  context,
  onWiden,
  onAddToChat,
}: {
  file: ReviewFile;
  layout: Layout;
  open: boolean;
  onToggle: () => void;
  context: number;
  onWiden: (context: number) => void;
  onAddToChat: (text: string) => void;
}) {
  // Every line in order, so a picked range is a slice of this list.
  const numbered = useMemo(() => file.hunks.map(numberHunk), [file.hunks]);
  const flat = useMemo(() => numbered.flat(), [numbered]);
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
    <section id={fileAnchor(file.path)} aria-label={file.path} className="overflow-hidden rounded-xl border border-line bg-paper shadow-panel">
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
      {open && (
        <div className="scroll-thin overflow-x-auto">
          {file.binary ? (
            <p className="px-4 py-3 text-[13px] text-ink-soft">Binary file, not shown.</p>
          ) : file.hunks.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-ink-soft">
              {file.truncated ? "This file's diff is too large to show here." : file.status === "renamed" ? "Renamed without changes." : "No line changes."}
            </p>
          ) : (
            <table className={cx("w-full border-collapse font-mono text-[12px] leading-[1.6]", layout === "split" && "table-fixed")}>
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
              <tbody>
                {file.hunks.map((h, hi) => (
                  <Fragment key={`${hi}:${h.header}`}>
                    <GapRow hunks={file.hunks} index={hi} layout={layout} onMore={() => onWiden(context + MORE_CONTEXT)} hunk={h} />
                    {layout === "unified"
                      ? numbered[hi]!.map((l, li) => <UnifiedRow key={li} line={l} picked={isPicked(l)} onPick={pick} />)
                      : splitRows(numbered[hi]!).map((r, ri) => <SplitRowView key={ri} row={r} isPicked={isPicked} onPick={pick} />)}
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

function UnifiedRow({ line, picked, onPick }: { line: ReviewLine; picked: boolean; onPick: (l: ReviewLine, extend: boolean) => void }) {
  return (
    <tr className={cx(LINE_BG[line.kind], picked && "outline-2 -outline-offset-2 outline-[#e9c900]")}>
      <LineNo n={line.oldNo} line={line} picked={picked} onPick={onPick} />
      <LineNo n={line.newNo} line={line} picked={picked} onPick={onPick} />
      <td aria-hidden="true" className={cx("w-4 pl-1.5 align-top select-none", LINE_FG[line.kind])}>
        {SIGN[line.kind]}
      </td>
      <td className={cx("pr-3 align-top whitespace-pre", LINE_FG[line.kind])}>
        <span className="sr-only">{line.kind === "add" ? "Added: " : line.kind === "del" ? "Removed: " : ""}</span>
        {line.text || " "}
      </td>
    </tr>
  );
}

function SplitRowView({
  row,
  isPicked,
  onPick,
}: {
  row: ReturnType<typeof splitRows>[number];
  isPicked: (l: ReviewLine | null) => boolean;
  onPick: (l: ReviewLine, extend: boolean) => void;
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
            LINE_FG[l.kind],
            which === "left" && "border-r border-line/70",
            picked && "outline-2 -outline-offset-2 outline-[#e9c900]",
          )}
        >
          <span className="sr-only">{l.kind === "add" ? "Added: " : l.kind === "del" ? "Removed: " : ""}</span>
          {l.text || " "}
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
