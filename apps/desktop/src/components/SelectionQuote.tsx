import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { GitFork, TextQuote } from "lucide-react";

/**
 * Select text in an agent's message and a small menu appears by it: "Quote" puts the text
 * in the composer as a `>` quote, and "Fork from here" starts a new thread carrying the
 * conversation up to that message. Agent messages are marked `data-agent-message`, with
 * their timeline key in `data-message-key`.
 */
export function SelectionQuote({
  root,
  onQuote,
  onFork,
}: {
  root: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
  onFork?: ((messageKey: string, text: string) => void) | undefined;
}) {
  const [at, setAt] = useState<{ top: number; left: number; text: string; key: string | null } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const host = root.current;
        const sel = document.getSelection();
        if (!host || !sel || sel.isCollapsed || sel.rangeCount === 0 || dragging.current) return setAt(null);
        const inMessage = (n: Node | null) => {
          const el = n instanceof Element ? n : n?.parentElement;
          const msg = el?.closest("[data-agent-message]");
          return msg && host.contains(msg) ? msg : null;
        };
        const start = inMessage(sel.anchorNode);
        if (!start || start !== inMessage(sel.focusNode)) return setAt(null);
        const text = sel.toString().trim();
        if (!text) return setAt(null);
        const rects = sel.getRangeAt(0).getClientRects();
        const last = rects[rects.length - 1];
        if (!last) return setAt(null);
        const box = host.getBoundingClientRect();
        setAt({ top: last.bottom - box.top + 6, left: Math.min(last.right - box.left, box.width - 130), text, key: start.getAttribute("data-message-key") });
      });
    };
    const down = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-quote-button]")) return;
      dragging.current = true;
      setAt(null);
    };
    const up = () => {
      dragging.current = false;
      measure();
    };
    document.addEventListener("selectionchange", measure);
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    const log = root.current?.querySelector('[role="log"]');
    log?.addEventListener("scroll", measure, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", measure);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
      log?.removeEventListener("scroll", measure);
    };
  }, [root]);

  if (!at) return null;
  const done = () => {
    document.getSelection()?.removeAllRanges();
    setAt(null);
  };
  const item = QUOTE_ITEM;
  return (
    <QuoteToolbar style={{ top: at.top, left: at.left }} className="-translate-x-1/2">
      <button
        type="button"
        onClick={() => {
          onQuote(at.text);
          done();
        }}
        className={item}
      >
        <TextQuote aria-hidden="true" className="size-3.5" />
        Quote
      </button>
      {onFork && at.key && (
        <button
          type="button"
          onClick={() => {
            onFork(at.key!, at.text);
            done();
          }}
          className={item}
        >
          <GitFork aria-hidden="true" className="size-3.5" />
          Fork from here
        </button>
      )}
    </QuoteToolbar>
  );
}

/** A button in the small menu by selected text. */
export const QUOTE_ITEM = "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink hover:bg-cream-deep";

/** The small menu shown by selected text (the conversation's, a terminal's). It never takes the selection away. */
export function QuoteToolbar({ style, className, children }: { style?: CSSProperties; className?: string; children: ReactNode }) {
  return (
    <div
      data-quote-button
      data-find-skip
      role="toolbar"
      aria-label="Selected text"
      onMouseDown={e => e.preventDefault()}
      style={style}
      className={`absolute z-30 flex items-center gap-0.5 rounded-lg border border-line-strong bg-paper p-0.5 shadow-pop ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
