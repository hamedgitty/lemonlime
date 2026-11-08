import { useEffect, useRef, useState, type RefObject } from "react";
import { TextQuote } from "lucide-react";

/**
 * Select text in an agent's message and a small "Quote" button appears by it; it puts
 * the text in the composer as a `>` quote. Agent messages are marked `data-agent-message`.
 */
export function SelectionQuote({ root, onQuote }: { root: RefObject<HTMLElement | null>; onQuote: (text: string) => void }) {
  const [at, setAt] = useState<{ top: number; left: number; text: string } | null>(null);
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
        setAt({ top: last.bottom - box.top + 6, left: Math.min(last.right - box.left, box.width - 90), text });
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
  return (
    <button
      type="button"
      data-quote-button
      data-find-skip
      onMouseDown={e => e.preventDefault()}
      onClick={() => {
        onQuote(at.text);
        document.getSelection()?.removeAllRanges();
        setAt(null);
      }}
      style={{ top: at.top, left: at.left }}
      className="absolute z-30 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-lg border border-line-strong bg-paper px-2.5 text-[13px] font-medium text-ink shadow-pop hover:bg-cream"
    >
      <TextQuote aria-hidden="true" className="size-3.5" />
      Quote
    </button>
  );
}
