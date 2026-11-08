import { useId, useMemo, useState } from "react";
import { ChevronRight, FileDiff } from "lucide-react";
import { parseUnifiedDiff, type DiffLine } from "../lib/diff.ts";
import { cx } from "./ui.tsx";

const CHANGE_LABEL = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" } as const;
const CHANGE_STYLE = {
  added: "bg-lime-soft text-leaf-deep",
  modified: "bg-lemon-soft text-[#6b5a00]",
  deleted: "bg-danger-soft text-danger",
  renamed: "bg-cream-deep text-ink-soft",
} as const;

const AUTO_EXPAND_LINES = 60;

export function DiffView({ path, change, diff, truncated }: { path: string; change: keyof typeof CHANGE_LABEL; diff: string; truncated: boolean }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [open, setOpen] = useState(parsed.lines.length <= AUTO_EXPAND_LINES);
  const bodyId = useId();
  const visible = parsed.lines.filter(l => l.kind !== "meta");

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-paper shadow-panel">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-cream/60 focus-visible:-outline-offset-2"
      >
        <ChevronRight aria-hidden="true" className={cx("size-4 shrink-0 text-ink-faint transition-transform duration-150", open && "rotate-90")} />
        <FileDiff aria-hidden="true" className="size-4 shrink-0 text-leaf" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{path}</span>
        <span className={cx("rounded-md px-1.5 py-0.5 text-xs font-medium", CHANGE_STYLE[change])}>{CHANGE_LABEL[change]}</span>
        <span className="text-xs tabular-nums">
          <span className="text-diff-add-strong">+{parsed.additions}</span> <span className="text-diff-del-strong">−{parsed.deletions}</span>
        </span>
      </button>
      {open && (
        <div id={bodyId} className="border-t border-line">
          <DiffBody lines={visible} truncated={truncated} />
        </div>
      )}
    </div>
  );
}

/** The changed lines of one file, as a table with old and new line numbers. */
export function DiffBody({ lines, truncated }: { lines: DiffLine[]; truncated: boolean }) {
  return (
    <div className="scroll-thin max-h-[480px] overflow-auto">
      {lines.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-ink-faint">No line changes to show.</p>
      ) : (
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
          <tbody>
            {lines.map((line, i) => (
              <DiffRow key={i} line={line} />
            ))}
          </tbody>
        </table>
      )}
      {truncated && <p className="border-t border-line bg-cream px-4 py-2 text-[13px] text-ink-soft">This diff was shortened because the file is large.</p>}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "hunk") {
    return (
      <tr className="bg-cream-deep/70 text-ink-faint">
        <td colSpan={3} className="px-3 py-0.5 select-none">
          {line.text}
        </td>
      </tr>
    );
  }
  const bg = line.kind === "add" ? "bg-diff-add" : line.kind === "del" ? "bg-diff-del" : "";
  const fg =
    line.kind === "add" ? "text-diff-add-strong" : line.kind === "del" ? "text-diff-del-strong" : line.kind === "note" ? "text-ink-faint italic" : "text-ink";
  return (
    <tr className={bg}>
      <td className="w-10 select-none border-r border-line/70 px-2 text-right align-top text-ink-faint tabular-nums">{line.oldNo ?? ""}</td>
      <td className="w-10 select-none border-r border-line/70 px-2 text-right align-top text-ink-faint tabular-nums">{line.newNo ?? ""}</td>
      <td className={cx("px-3 align-top whitespace-pre", fg)}>{line.text || " "}</td>
    </tr>
  );
}
