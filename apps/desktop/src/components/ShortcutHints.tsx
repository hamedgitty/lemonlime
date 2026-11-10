import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IS_MAC, keyCaps, keysFor, SHORTCUT_TARGETS, SHORTCUTS, type ShortcutId } from "../lib/shortcuts.ts";

/** How long ⌘ (Ctrl) is held before the hints show, so quick shortcuts never flash them. */
const HOLD_MS = 450;

interface Hint {
  key: string;
  keys: string[];
  left: number;
  top: number;
  /** Inside the right end of a wide row, or under (over, at the bottom of the window) a small button. */
  place: "inside" | "below" | "above";
}

function visible(el: Element): DOMRect | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
  if ((el as HTMLElement).closest("[hidden], [inert]")) return null;
  return r;
}

/** Where each shortcut's button is right now, with its keys. */
function findHints(overrides: Record<string, string>): Hint[] {
  const out: Hint[] = [];
  const seen = new Set<Element>();
  const add = (id: ShortcutId, el: Element) => {
    const combo = keysFor(id, overrides);
    const r = visible(el);
    if (!combo || !r || seen.has(el)) return;
    seen.add(el);
    const wide = r.width > 90;
    const above = !wide && r.bottom + 28 > window.innerHeight;
    out.push({
      key: `${id}:${out.length}`,
      keys: keyCaps(combo),
      left: wide ? r.right - 8 : r.left + r.width / 2,
      top: wide ? r.top + r.height / 2 : above ? r.top - 4 : r.bottom + 4,
      place: wide ? "inside" : above ? "above" : "below",
    });
  };
  for (const t of SHORTCUT_TARGETS) {
    const els = [...document.querySelectorAll(t.selector)].filter(el => t.text === undefined || el.textContent?.trim() === t.text);
    const el = els.find(e => visible(e));
    if (el) add(t.id, el);
  }
  const ids = new Set<string>(SHORTCUTS.map(s => s.id));
  for (const el of document.querySelectorAll("[data-shortcut]")) {
    const id = el.getAttribute("data-shortcut") ?? "";
    if (ids.has(id)) add(id as ShortcutId, el);
  }
  return out;
}

/**
 * Hold ⌘ (Ctrl elsewhere) for a moment and each button with a shortcut shows its keys.
 * Appears and goes at once: it answers a key, so it never animates.
 */
export function ShortcutHints({ enabled, overrides }: { enabled: boolean; overrides: Record<string, string> }) {
  const [hints, setHints] = useState<Hint[] | null>(null);
  useEffect(() => {
    if (!enabled) return setHints(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isMod = (e: KeyboardEvent) => (IS_MAC ? e.key === "Meta" : e.key === "Control");
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      setHints(null);
    };
    const down = (e: KeyboardEvent) => {
      if (isMod(e) && !e.repeat && !e.shiftKey && !e.altKey) {
        clearTimeout(timer);
        timer = setTimeout(() => setHints(findHints(overrides)), HOLD_MS);
      } else if (!isMod(e)) hide();
    };
    const up = (e: KeyboardEvent) => {
      if (isMod(e)) hide();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      hide();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, [enabled, overrides]);

  if (!hints?.length) return null;
  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[70]">
      {hints.map(h => (
        <span
          key={h.key}
          style={{ left: h.left, top: h.top }}
          className={
            h.place === "inside"
              ? "absolute inline-flex -translate-x-full -translate-y-1/2 gap-0.5 rounded-md bg-lime px-1.5 py-0.5 text-[12px] font-medium text-on-citrus shadow-panel"
              : h.place === "above"
                ? "absolute inline-flex -translate-x-1/2 -translate-y-full gap-0.5 rounded-md bg-lime px-1.5 py-0.5 text-[12px] font-medium whitespace-nowrap text-on-citrus shadow-panel"
                : "absolute inline-flex -translate-x-1/2 gap-0.5 rounded-md bg-lime px-1.5 py-0.5 text-[12px] font-medium whitespace-nowrap text-on-citrus shadow-panel"
          }
        >
          {h.keys.map((k, i) => (
            <span key={i}>{k}</span>
          ))}
        </span>
      ))}
    </div>,
    document.body,
  );
}
