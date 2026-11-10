import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FileText, Search } from "lucide-react";
import { fuzzyMatch } from "@lemonlime/protocol";
import { composing } from "../lib/ime.ts";
import { Highlighted } from "./Highlighted.tsx";
import { Kbd } from "./primitives.tsx";
import { cx } from "./ui.tsx";

/**
 * ⌘P in a thread: find a file in the thread's folder by fuzzy search (the same list as the
 * composer's @ menu) and open it in a panel tab.
 */
export function QuickOpen({
  open,
  onOpenChange,
  searchFiles,
  onPick,
  connected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchFiles: (query: string, signal?: AbortSignal) => Promise<string[]>;
  onPick: (path: string) => void;
  connected: boolean;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  // What was typed when the list on screen was found. Enter waits until it is what is typed now.
  const [answers, setAnswers] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    // Last time's list isn't this time's answer.
    setFiles([]);
    setAnswers(null);
  }, [open]);

  useEffect(() => {
    if (!open || !connected) return;
    const ctl = new AbortController();
    setLoading(true);
    // A short pause so fast typing asks once.
    const t = setTimeout(() => {
      searchFiles(query, ctl.signal)
        .then(list => {
          setFiles(list);
          setAnswers(query);
          setActive(0);
        })
        .catch(() => undefined)
        .finally(() => !ctl.signal.aborted && setLoading(false));
    }, 60);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [open, query, connected, searchFiles]);

  const results = useMemo(() => files.map(path => ({ path, positions: fuzzyMatch(query, path)?.positions ?? [] })), [files, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;
  useEffect(() => {
    listRef.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onOpenChange(false);
    requestAnimationFrame(() => onPick(path));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (composing(e)) return;
    const move = (to: number) => {
      e.preventDefault();
      if (results.length) setActive((to + results.length) % results.length);
    };
    if (e.key === "ArrowDown") move(current + 1);
    else if (e.key === "ArrowUp") move(current - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      // The list may still be the one for what was typed before: don't open a file from it.
      if (answers === query) pick(results[current]?.path);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={o => onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim/20" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={returnTo}
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(520px,72vh)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-paper text-ink shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Open a file</Dialog.Title>
          <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-4">
            <Search aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
            <input
              ref={input}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Find a file in this thread's folder"
              aria-label="Find a file"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={results.length > 0}
              aria-controls={listId}
              aria-activedescendant={results.length ? optionId(current) : undefined}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink-faint"
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label="Files" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
            {!connected ? (
              <p className="px-3 py-6 text-center text-[14px] text-ink-soft">Files can be opened once the thread is running.</p>
            ) : results.length === 0 && !loading ? (
              <p className="px-3 py-6 text-center text-[14px] text-ink-soft">{query.trim() ? `No files match “${query.trim()}”.` : "No files here yet."}</p>
            ) : (
              results.map((r, i) => {
                const slash = r.path.lastIndexOf("/");
                const name = r.path.slice(slash + 1);
                const dir = slash >= 0 ? r.path.slice(0, slash) : "";
                return (
                  <div
                    key={r.path}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === current}
                    onMouseMove={() => i !== current && setActive(i)}
                    onClick={() => pick(r.path)}
                    className={cx("flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-[14px]", i === current && "bg-cream-deep")}
                  >
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
                    <span className="shrink-0 font-medium">
                      <Highlighted text={name} positions={r.positions} offset={slash + 1} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-faint">
                      <Highlighted text={dir} positions={r.positions.filter(p => p < slash)} />
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex shrink-0 items-center gap-4 border-t border-line px-4 py-2 text-[13px] text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              Move
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↩</Kbd>
              Open in a tab
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
