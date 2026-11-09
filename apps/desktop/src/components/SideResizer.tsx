import { useRef } from "react";
import { KEY_STEP, KEY_STEP_BIG, dragWidth, type SideBounds } from "../lib/sideWidth.ts";
import { cx } from "./ui.tsx";

/**
 * The draggable edge of a side column. `edge` is the side of the column it sits on.
 * Drag to resize; drag well past the narrowest width to fold the column away (when
 * `onFold` is given). Arrow keys nudge it, Home and End jump to the ends, double-click
 * goes back to the default width. The parent must be positioned.
 */
export function SideResizer({
  edge,
  width,
  bounds,
  label,
  onWidth,
  onFold,
}: {
  /** Top and bottom edges resize the height. */
  edge: "left" | "right" | "top" | "bottom";
  width: number;
  bounds: SideBounds;
  label: string;
  onWidth: (w: number, save: boolean) => void;
  onFold?: () => void;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  // The column may be shown narrower than its saved width (a small window caps it), so start from what's on screen.
  const vertical = edge === "top" || edge === "bottom";
  const shown = (el: HTMLElement) => {
    const r = el.parentElement?.getBoundingClientRect();
    return Math.round((vertical ? r?.height : r?.width) || width);
  };
  // Dragging toward the outside of the column makes it bigger.
  const outward = (d: number) => (edge === "right" || edge === "bottom" ? d : -d);
  const at = (e: { clientX: number; clientY: number }) => (vertical ? e.clientY : e.clientX);
  const move = (pos: number, save: boolean) => {
    const d = drag.current;
    if (!d) return;
    const w = dragWidth(d.w, outward(pos - d.x), bounds, Boolean(onFold));
    if (w === null) {
      drag.current = null;
      onFold?.();
    } else onWidth(w, save);
  };
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "horizontal" : "vertical"}
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      title={onFold ? "Drag to resize, or drag in to hide" : "Drag to resize"}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: at(e), w: shown(e.currentTarget) };
      }}
      onPointerMove={e => move(at(e), false)}
      onPointerUp={e => {
        move(at(e), true);
        drag.current = null;
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onWidth(bounds.default, true)}
      onKeyDown={e => {
        const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
        const now = shown(e.currentTarget);
        if (e.key === (vertical ? "ArrowUp" : "ArrowLeft")) onWidth(now + outward(-step), true);
        else if (e.key === (vertical ? "ArrowDown" : "ArrowRight")) onWidth(now + outward(step), true);
        else if (e.key === "Home") onWidth(bounds.min, true);
        else if (e.key === "End") onWidth(bounds.max, true);
        else return;
        e.preventDefault();
      }}
      className={cx(
        "absolute z-20 touch-none outline-none hover:bg-line-strong/60 focus-visible:bg-leaf/40 active:bg-line-strong",
        vertical ? "inset-x-0 h-[6px] cursor-row-resize" : "inset-y-0 w-[6px] cursor-col-resize",
        { right: "-right-[3px]", left: "-left-[3px]", top: "-top-[3px]", bottom: "-bottom-[3px]" }[edge],
      )}
    />
  );
}
