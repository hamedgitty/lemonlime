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
  edge: "left" | "right";
  width: number;
  bounds: SideBounds;
  label: string;
  onWidth: (w: number, save: boolean) => void;
  onFold?: () => void;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  // The column may be shown narrower than its saved width (a small window caps it), so start from what's on screen.
  const shown = (el: HTMLElement) => Math.round(el.parentElement?.getBoundingClientRect().width || width);
  // Dragging toward the outside of the column makes it wider.
  const outward = (dx: number) => (edge === "right" ? dx : -dx);
  const move = (clientX: number, save: boolean) => {
    const d = drag.current;
    if (!d) return;
    const w = dragWidth(d.w, outward(clientX - d.x), bounds, Boolean(onFold));
    if (w === null) {
      drag.current = null;
      onFold?.();
    } else onWidth(w, save);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
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
        drag.current = { x: e.clientX, w: shown(e.currentTarget) };
      }}
      onPointerMove={e => move(e.clientX, false)}
      onPointerUp={e => {
        move(e.clientX, true);
        drag.current = null;
      }}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onWidth(bounds.default, true)}
      onKeyDown={e => {
        const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
        const now = shown(e.currentTarget);
        if (e.key === "ArrowLeft") onWidth(now + outward(-step), true);
        else if (e.key === "ArrowRight") onWidth(now + outward(step), true);
        else if (e.key === "Home") onWidth(bounds.min, true);
        else if (e.key === "End") onWidth(bounds.max, true);
        else return;
        e.preventDefault();
      }}
      className={cx(
        "absolute inset-y-0 z-20 w-[6px] cursor-col-resize touch-none outline-none hover:bg-line-strong/60 focus-visible:bg-leaf/40 active:bg-line-strong",
        edge === "right" ? "-right-[3px]" : "-left-[3px]",
      )}
    />
  );
}
