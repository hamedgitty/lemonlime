import { useCallback, useState } from "react";

/**
 * Widths for the app's side columns: the main sidebar, the side panel and the list column
 * on the Skills and Plugins pages. Each is dragged by its edge and remembered on this
 * computer. Dragging well past the narrowest width folds the column away.
 */

export interface SideBounds {
  min: number;
  max: number;
  default: number;
}

export const SIDEBAR: SideBounds = { min: 240, max: 440, default: 288 };
export const SIDE_PANEL: SideBounds = { min: 300, max: 760, default: 420 };
export const LIST_COLUMN: SideBounds = { min: 220, max: 480, default: 300 };

/** How far past the minimum a drag has to go before the column folds away. */
export const FOLD_PAST = 64;
/** Arrow keys move the edge this far (Shift moves it further). */
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;

export const clampWidth = (w: number, b: SideBounds) => Math.round(Math.min(b.max, Math.max(b.min, w)));

/** The width after dragging the edge `delta` px outward, or null when the drag means "fold it away". */
export function dragWidth(start: number, delta: number, b: SideBounds, canFold: boolean): number | null {
  const w = start + delta;
  if (canFold && w < b.min - FOLD_PAST) return null;
  return clampWidth(w, b);
}

export const KEYS = {
  sidebar: "lemonlime:sidebar-width",
  sidePanel: "lemonlime:side-panel-width",
  listColumn: "lemonlime:list-width",
  listFolded: "lemonlime:list-folded",
} as const;

function readNumber(key: string): number | undefined {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the width just isn't remembered */
  }
}

export const loadWidth = (key: string, b: SideBounds) => clampWidth(readNumber(key) ?? b.default, b);
export const saveWidth = (key: string, w: number) => store(key, String(Math.round(w)));

export function loadFolded(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
export const saveFolded = (key: string, folded: boolean) => store(key, folded ? "1" : null);

/** A remembered width: `set(w, true)` saves it (at the end of a drag), `set(w, false)` only shows it. */
export function useSideWidth(key: string, b: SideBounds): [number, (w: number, save: boolean) => void] {
  const [width, setWidth] = useState(() => loadWidth(key, b));
  const set = useCallback(
    (w: number, save: boolean) => {
      const next = clampWidth(w, b);
      setWidth(next);
      if (save) saveWidth(key, next);
    },
    [key, b],
  );
  return [width, set];
}

/** A remembered folded/open flag. */
export function useFolded(key: string): [boolean, (folded: boolean) => void] {
  const [folded, setFolded] = useState(() => loadFolded(key));
  const set = useCallback(
    (f: boolean) => {
      setFolded(f);
      saveFolded(key, f);
    },
    [key],
  );
  return [folded, set];
}
