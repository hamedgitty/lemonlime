import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { clearMatches, findRanges, matchLabel, paintMatches, revealRange, stepMatch } from "../lib/findInThread.ts";
import { IconButton } from "./ui.tsx";

/**
 * The ⌘F bar over a thread's timeline: matches are highlighted in place, Enter and
 * Shift+Enter move between them, Escape closes and puts focus back where it was.
 */
export function FindBar({
  root,
  version,
  focusNonce,
  onClose,
}: {
  /** Holds the timeline (its `role="log"` element is searched). */
  root: RefObject<HTMLElement | null>;
  /** Changes when the timeline does, to search again. */
  version: unknown;
  /** Changes when ⌘F is pressed again, to focus and select the query. */
  focusNonce: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(-1);
  const [total, setTotal] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  const ranges = useRef<Range[]>([]);
  const lastQuery = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(null);

  useLayoutEffect(() => {
    returnTo.current ??= document.activeElement;
    input.current?.focus();
    input.current?.select();
  }, [focusNonce]);

  const close = () => {
    clearMatches();
    onClose();
    const back = returnTo.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };

  useEffect(() => {
    const t = setTimeout(
      () => {
        const log = root.current?.querySelector<HTMLElement>('[role="log"]');
        const found = log ? findRanges(log, query) : [];
        ranges.current = found;
        setTotal(found.length);
        const fresh = lastQuery.current !== query;
        lastQuery.current = query;
        // A new query starts at the first match; new messages keep your place.
        const c = currentRef.current;
        const next = found.length === 0 ? -1 : fresh || c < 0 ? 0 : Math.min(c, found.length - 1);
        currentRef.current = next;
        setCurrent(next);
        paintMatches(found, next);
        const scroller = root.current?.querySelector<HTMLElement>('[role="log"]');
        if (fresh && found[next] && scroller) revealRange(found[next], scroller);
      },
      query === lastQuery.current ? 150 : 60,
    );
    return () => clearTimeout(t);
  }, [query, version, root]);

  useEffect(() => () => clearMatches(), []);

  const step = (dir: 1 | -1) => {
    const next = stepMatch(currentRef.current, ranges.current.length, dir);
    currentRef.current = next;
    setCurrent(next);
    paintMatches(ranges.current, next);
    const r = ranges.current[next];
    const scroller = root.current?.querySelector<HTMLElement>('[role="log"]');
    if (r && scroller) revealRange(r, scroller);
  };
  const label = matchLabel(current, total, query);

  return (
    <div
      data-find-skip
      role="search"
      aria-label="Find in thread"
      className="absolute top-3 right-6 z-20 flex h-10 items-center gap-1 rounded-xl border border-line bg-paper pr-1 pl-3 shadow-pop"
    >
      <Search aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
      <input
        ref={input}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        placeholder="Find in thread"
        aria-label="Find in thread"
        aria-describedby="find-count"
        className="h-8 w-[200px] min-w-0 bg-transparent px-1.5 text-[14px] text-ink outline-none placeholder:text-ink-faint"
      />
      <span id="find-count" role="status" className="min-w-[72px] text-right text-[13px] text-ink-soft tabular-nums">
        {label}
      </span>
      <IconButton label="Previous match (Shift Enter)" disabled={total === 0} onClick={() => step(-1)}>
        <ChevronUp aria-hidden="true" className="size-4" />
      </IconButton>
      <IconButton label="Next match (Enter)" disabled={total === 0} onClick={() => step(1)}>
        <ChevronDown aria-hidden="true" className="size-4" />
      </IconButton>
      <IconButton label="Close (Esc)" onClick={close}>
        <X aria-hidden="true" className="size-4" />
      </IconButton>
    </div>
  );
}
