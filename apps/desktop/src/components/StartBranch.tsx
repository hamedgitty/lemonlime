import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Check, GitBranch, GitFork } from "lucide-react";
import type { BranchInfo } from "@lemonlime/protocol";
import { existingBranchProblem, filterBranches } from "../lib/branches.ts";
import { inDesktopShell, listBranches } from "../lib/native.ts";
import { SegmentedControl, TextInput, cx } from "./ui.tsx";
import { composing } from "../lib/ime.ts";

export type StartMode = "new" | "existing";

/** The project's branches for the picker: null while looking, with what went wrong if it couldn't. */
export function useBranches(repoPath: string, runnerPath: string | undefined): { branches: BranchInfo[] | null; failed: string | null } {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    setBranches(null);
    setFailed(null);
    if (!repoPath || !inDesktopShell()) return;
    let cancelled = false;
    listBranches(repoPath, runnerPath)
      .then(l => !cancelled && setBranches(l.branches))
      .catch(err => !cancelled && setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, runnerPath]);
  return { branches, failed };
}

/**
 * Where a new local thread starts: a searchable list of the project's branches (local and
 * origin's), with free typing for any other name, and whether the thread makes a new branch
 * from it or works on that branch itself.
 */
export function StartBranch({
  repoPath,
  branches,
  failed,
  value,
  onChange,
  mode,
  onMode,
  forkFrom,
  onStartFresh,
}: {
  repoPath: string;
  branches: BranchInfo[] | null;
  /** Why the branches couldn't be listed. */
  failed: string | null;
  value: string;
  onChange: (v: string) => void;
  mode: StartMode;
  onMode: (m: StartMode) => void;
  /** A fork: the thread starts with this branch's code. */
  forkFrom?: string | null | undefined;
  onStartFresh?: () => void;
}) {
  const [active, setActive] = useState(0);
  const [typing, setTyping] = useState(false);
  const listId = useId();
  const inputId = useId();

  // While typing, the list narrows; after picking, it shows everything again.
  const shown = useMemo(() => filterBranches(branches ?? [], typing ? value : ""), [branches, value, typing]);
  useEffect(() => setActive(0), [value, typing]);
  const pick = (b: BranchInfo) => {
    onChange(b.name);
    setTyping(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!shown.length || composing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(i => (i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === "Enter" && typing) {
      e.preventDefault();
      pick(shown[active]!);
    }
  };
  const problem = mode === "existing" ? existingBranchProblem(branches, value, repoPath) : null;
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="space-y-2">
      {forkFrom && (
        <div className="flex items-start gap-2 rounded-lg bg-cream-deep px-2.5 py-2 text-[13px] leading-snug">
          <GitFork aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-soft" />
          <p className="min-w-0 flex-1 text-pretty">
            Starts with the code from <span className="font-mono text-[12px] break-all">{forkFrom}</span>.{" "}
            {onStartFresh && (
              <button type="button" onClick={onStartFresh} className="font-medium text-leaf hover:text-leaf-deep">
                Start fresh from {value || "the base"} instead
              </button>
            )}
          </p>
        </div>
      )}
      <div>
        <label htmlFor={inputId} className="mb-1 block text-[14px] font-medium">
          {mode === "existing" ? "Work on branch" : forkFrom ? "Compare with branch" : "Start from branch"}
        </label>
        <TextInput
          id={inputId}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          {...(shown.length ? { "aria-activedescendant": optionId(active) } : {})}
          value={value}
          onChange={e => {
            onChange(e.target.value);
            setTyping(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="main, or paste a pull request link"
          className="font-mono text-[13px]"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {failed ? (
        <p className="text-[13px] text-ink-faint">Couldn't list the branches, so type one. {failed}</p>
      ) : branches === null && inDesktopShell() && repoPath ? (
        <p className="text-[13px] text-ink-faint">Looking for branches…</p>
      ) : shown.length > 0 ? (
        <ul id={listId} role="listbox" aria-label="Branches" className="scroll-thin -mx-1 max-h-[188px] overflow-y-auto">
          {shown.map((b, i) => (
            <li
              key={`${b.remote ? "r" : "l"}:${b.name}`}
              id={optionId(i)}
              role="option"
              aria-selected={b.name === value}
              onPointerDown={e => e.preventDefault()}
              onClick={() => pick(b)}
              className={cx(
                "flex h-8 cursor-default items-center gap-2 rounded-[7px] px-2 text-[13px]",
                i === active && typing ? "bg-cream-deep" : "hover:bg-cream-deep",
                b.name === value && "font-medium",
              )}
            >
              <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
              {b.name === value && <Check aria-label="Chosen" className="size-3.5 shrink-0 text-leaf" />}
              {b.remote ? (
                <span className="shrink-0 text-[12px] text-ink-faint">On origin</span>
              ) : b.checkedOutAt ? (
                <span className="shrink-0 text-[12px] text-ink-faint" title={b.checkedOutAt}>
                  Checked out
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : typing && value.trim() && branches ? (
        <p className="text-[13px] text-ink-faint">No branch matches. The name is used as typed.</p>
      ) : null}
      {!forkFrom && (
        <SegmentedControl
          label="What the thread does with the branch"
          value={mode}
          onChange={onMode}
          options={[
            { value: "new", label: "New branch from it", hint: "The agent works on a branch of its own, made from this one." },
            { value: "existing", label: "Work on this branch", hint: "The agent checks this branch out in its own folder and commits to it." },
          ]}
        />
      )}
      {problem && (
        <p role="alert" className="text-[13px] leading-snug text-pretty text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
