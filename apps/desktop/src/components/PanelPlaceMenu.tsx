import type { ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Maximize2, Minimize2 } from "lucide-react";
import type { PanelPlace } from "../lib/sideWidth.ts";
import { Menu, MenuLabel } from "./primitives.tsx";
import { IconButton, cx } from "./ui.tsx";

const PLACES: { place: PanelPlace; label: string }[] = [
  { place: "left", label: "Move to the left" },
  { place: "right", label: "Move to the right" },
  { place: "top", label: "Move to the top" },
  { place: "bottom", label: "Move to the bottom" },
];

const TILE =
  "inline-flex size-9 cursor-default items-center justify-center rounded-lg text-ink-soft outline-none data-[highlighted]:bg-cream-deep data-[highlighted]:text-ink";

/** A little window with the panel's part filled in, for the menu's tiles. */
function Glyph({ fill }: { fill: PanelPlace | "all" | "split" }) {
  const part =
    fill === "all"
      ? { x: 3, y: 3, w: 14, h: 10 }
      : fill === "split"
        ? { x: 10, y: 3, w: 7, h: 10 }
        : { left: { x: 3, y: 3, w: 5, h: 10 }, right: { x: 12, y: 3, w: 5, h: 10 }, top: { x: 3, y: 3, w: 14, h: 4 }, bottom: { x: 3, y: 9, w: 14, h: 4 } }[
            fill
          ];
  return (
    <svg viewBox="0 0 20 16" aria-hidden="true" className="h-4 w-5">
      <rect x="1" y="1" width="18" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {fill === "split" && <rect x="3" y="3" width="6" height="10" rx="1" fill="currentColor" opacity="0.35" />}
      <rect x={part.x} y={part.y} width={part.w} height={part.h} rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * The panel's layout menu, on its expand button: move it to any side of the page, and fill
 * the window with it or put it back beside the page.
 */
export function PanelPlaceMenu({
  place,
  onPlace,
  full,
  onFull,
  size = "md",
}: {
  place: PanelPlace;
  onPlace: (p: PanelPlace) => void;
  full: boolean;
  onFull: (full: boolean) => void;
  size?: "sm" | "md";
}) {
  const tile = (chosen: boolean, label: string, onClick: () => void, glyph: ReactNode) => (
    <BaseMenu.Item key={label} aria-label={label} title={label} onClick={onClick} className={cx(TILE, chosen && "bg-cream-hover text-ink")}>
      {glyph}
    </BaseMenu.Item>
  );
  return (
    <Menu
      align="end"
      className="min-w-0"
      trigger={
        <IconButton label="Panel layout" className={size === "sm" ? "size-7" : undefined}>
          {full ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </IconButton>
      }
    >
      <MenuLabel>Move</MenuLabel>
      <div className="flex gap-1 px-1 pb-1">
        {PLACES.map(p =>
          tile(
            !full && place === p.place,
            p.label,
            () => {
              onPlace(p.place);
              onFull(false);
            },
            <Glyph fill={p.place} />,
          ),
        )}
      </div>
      <MenuLabel>Fill and arrange</MenuLabel>
      <div className="flex gap-1 px-1 pb-1">
        {tile(full, "Fill the window", () => onFull(true), <Glyph fill="all" />)}
        {tile(!full, "Beside the page", () => onFull(false), <Glyph fill="split" />)}
      </div>
    </Menu>
  );
}
