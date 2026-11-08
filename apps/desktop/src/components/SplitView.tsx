import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { canSplit, dropZoneAt, layoutBoxes, panes, type Divider, type DropZone, type PaneNode, type SplitLayout } from "../lib/splitLayout.ts";
import { keyCaps } from "../lib/shortcuts.ts";
import { Tip } from "./primitives.tsx";
import { cx } from "./ui.tsx";

export interface PaneInfo {
  active: boolean;
  /** More than one pane is showing (or could be, when one is maximised). */
  split: boolean;
  maximised: boolean;
  /** Position in reading order, from 1. */
  index: number;
  /** The pane's width in pixels (0 before it has been measured). */
  width: number;
}

/** What the four edges and the middle do with a dropped thread. */
const ZONE_LABEL: Record<DropZone, string> = {
  left: "Open on the left",
  right: "Open on the right",
  top: "Open above",
  bottom: "Open below",
  center: "Open here",
};

/**
 * Lays out the panes of a split side by side. Every pane stays mounted where it is while
 * the tree changes shape (they're positioned, not nested), so a thread's live session
 * and scroll position survive splitting and closing its neighbours.
 */
export function SplitView({
  layout,
  renderPane,
  onFocusPane,
  onResize,
  onEven,
  dragging,
  onDrop,
  dimInactive = true,
}: {
  layout: SplitLayout;
  renderPane: (pane: PaneNode, info: PaneInfo) => ReactNode;
  onFocusPane: (paneId: string) => void;
  /** Move a divider by `deltaPx` from where the drag began (`start` is the layout then). */
  onResize: (start: SplitLayout, divider: Divider, deltaPx: number, totalPx: number) => void;
  /** Double-clicking a divider evens its split out. */
  onEven: (splitId: string) => void;
  /** A thread being dragged from the sidebar: the panes show where it can land. */
  dragging: boolean;
  onDrop: (paneId: string, zone: DropZone) => void;
  /** The panes you aren't typing in sit back a little (Settings → Appearance). */
  dimInactive?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize(s => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { panes: boxes, dividers } = layoutBoxes(layout);
  const order = panes(layout);
  const split = order.length > 1;
  const splittable = canSplit(layout);
  const max = layout.maximised;

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      {boxes.map(({ id, box: b }) => {
        const pane = order.find(p => p.id === id)!;
        const hidden = max !== null && max !== id;
        const full = max === id || !split;
        const active = layout.active === id;
        return (
          <div
            key={id}
            data-pane={id}
            className={cx(
              "absolute min-w-0 overflow-hidden",
              hidden ? "hidden" : "flex",
              !full && b.x > 0 && "border-l border-line",
              !full && b.y > 0 && "border-t border-line",
            )}
            style={full ? { inset: 0 } : { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
            onPointerDownCapture={() => !active && onFocusPane(id)}
            onFocusCapture={() => !active && onFocusPane(id)}
          >
            {renderPane(pane, { active, split, maximised: max === id, index: order.indexOf(pane) + 1, width: Math.round((full ? 1 : b.w) * size.w) })}
            {/* The panes you aren't typing in sit back a little. */}
            {dimInactive && split && !active && !hidden && <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 bg-ink/[0.035]" />}
            {dragging && !hidden && <DropTarget splittable={splittable} onDrop={zone => onDrop(id, zone)} />}
          </div>
        );
      })}
      {split &&
        max === null &&
        dividers.map(d => <DividerHandle key={`${d.splitId}:${d.index}`} divider={d} layout={layout} size={size} onResize={onResize} onEven={onEven} />)}
    </div>
  );
}

/** Lies over a pane while a thread is dragged: the edges split it, the middle replaces it. */
function DropTarget({ splittable, onDrop }: { splittable: boolean; onDrop: (zone: DropZone) => void }) {
  const [zone, setZone] = useState<DropZone | null>(null);
  const area: Record<DropZone, string> = {
    left: "inset-y-2 left-2 w-[calc(50%-12px)]",
    right: "inset-y-2 right-2 w-[calc(50%-12px)]",
    top: "inset-x-2 top-2 h-[calc(50%-12px)]",
    bottom: "inset-x-2 bottom-2 h-[calc(50%-12px)]",
    center: "inset-2",
  };
  return (
    <div
      className="absolute inset-0 z-30"
      onDragOver={e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const next = dropZoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY, splittable);
        if (next !== zone) setZone(next);
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={e => {
        e.preventDefault();
        const at = dropZoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY, splittable);
        setZone(null);
        onDrop(at);
      }}
    >
      {zone && (
        <div
          aria-hidden="true"
          className={cx(
            "pointer-events-none absolute flex items-center justify-center rounded-xl border-2 border-dashed border-leaf/50 bg-lime-soft/55",
            area[zone],
          )}
        >
          <span className="rounded-full bg-paper px-3 py-1 text-[13px] font-medium text-ink shadow-panel">{ZONE_LABEL[zone]}</span>
        </div>
      )}
    </div>
  );
}

/** The line between two panes: drag it (or use the arrow keys) to share the space differently. */
function DividerHandle({
  divider: d,
  layout,
  size,
  onResize,
  onEven,
}: {
  divider: Divider;
  layout: SplitLayout;
  size: { w: number; h: number };
  onResize: (start: SplitLayout, divider: Divider, deltaPx: number, totalPx: number) => void;
  onEven: (splitId: string) => void;
}) {
  const drag = useRef<{ from: number; start: SplitLayout } | null>(null);
  const row = d.dir === "row";
  const totalPx = row ? d.box.w * size.w : d.box.h * size.h;
  const style = row
    ? { left: `${d.at * 100}%`, top: `${d.box.y * 100}%`, height: `${d.box.h * 100}%` }
    : { top: `${d.at * 100}%`, left: `${d.box.x * 100}%`, width: `${d.box.w * 100}%` };
  const share = Math.round(((d.at - (row ? d.box.x : d.box.y)) / (row ? d.box.w : d.box.h)) * 100);
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize the panes"
      aria-valuenow={share}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      style={style}
      onPointerDown={e => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { from: row ? e.clientX : e.clientY, start: layout };
      }}
      onPointerMove={e => {
        const g = drag.current;
        if (g) onResize(g.start, d, (row ? e.clientX : e.clientY) - g.from, totalPx);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => onEven(d.splitId)}
      onKeyDown={e => {
        const step = e.shiftKey ? 64 : 16;
        const back = row ? "ArrowLeft" : "ArrowUp";
        const on = row ? "ArrowRight" : "ArrowDown";
        if (e.key !== back && e.key !== on) return;
        e.preventDefault();
        onResize(layout, d, e.key === on ? step : -step, totalPx);
      }}
      className={cx(
        "absolute z-20 outline-none hover:bg-line-strong/60 focus-visible:bg-leaf/40 active:bg-line-strong",
        row ? "w-[6px] -translate-x-[3px] cursor-col-resize" : "h-[6px] -translate-y-[3px] cursor-row-resize",
      )}
    />
  );
}

/**
 * A pane's slim header: what's in it, then its own buttons, then maximise and close.
 * The active pane's header is a touch brighter, with a thin lime line along the top.
 */
export function PaneHeader({
  active,
  glyph,
  title,
  children,
  controls,
}: {
  active: boolean;
  glyph?: ReactNode;
  title: string;
  children?: ReactNode;
  controls: PaneControls;
}) {
  return (
    <header
      data-tauri-drag-region
      className={cx(
        "flex h-10 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3",
        active ? "bg-paper shadow-[inset_0_2px_0_var(--color-lime-2)]" : "bg-cream",
      )}
    >
      {glyph}
      <h2
        className={cx("ml-1 min-w-0 flex-1 truncate font-sans text-[13.5px] font-semibold tracking-normal", active ? "text-ink" : "text-ink-soft")}
        title={title}
      >
        {title}
      </h2>
      {children}
      <PaneButton
        label={controls.maximised ? "Restore the split" : "Maximise this pane"}
        keys={controls.maximiseKeys}
        onClick={controls.onMaximise}
        pressed={controls.maximised}
      >
        {controls.maximised ? <Minimize2 /> : <Maximize2 />}
      </PaneButton>
      <PaneButton label="Close this pane" onClick={controls.onClose}>
        <X />
      </PaneButton>
    </header>
  );
}

export interface PaneControls {
  maximised: boolean;
  onMaximise: () => void;
  onClose: () => void;
  /** The maximise shortcut, for its tooltip ("" when turned off). */
  maximiseKeys: string;
}

/** A small icon button for pane headers. */
export function PaneButton({
  label,
  keys,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  keys?: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tip
      label={
        keys ? (
          <>
            {label} <span className="font-normal opacity-75">{keyCaps(keys).join(" ")}</span>
          </>
        ) : (
          label
        )
      }
      side="bottom"
    >
      <button
        type="button"
        aria-label={label}
        {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-cream-deep hover:text-ink disabled:opacity-40 [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tip>
  );
}
