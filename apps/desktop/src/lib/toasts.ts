/**
 * Rules for toasts that carry a key or belong to a thread (components/Toaster.tsx shows
 * them). A key stands for one kind of notice: a new one with the same key replaces the one
 * showing, and the same notice again within a moment is dropped rather than shown twice.
 * A thread's toast shows plainly while the thread is on screen, and with "Open thread"
 * while it isn't.
 */

/** The same keyed notice again within this long is a repeat. */
export const TOAST_REPEAT_MS = 2000;

export interface KeyedToast {
  /** When it was last shown or replaced. */
  at: number;
  /** What it said, to tell a repeat from news. */
  text: string;
  /** Still on screen. */
  open: boolean;
}

/** What to do with a toast whose key was used before. */
export function keyedToast(prev: KeyedToast | undefined, text: string, now: number): "add" | "replace" | "drop" {
  if (!prev?.open) return "add";
  if (prev.text === text && now - prev.at < TOAST_REPEAT_MS) return "drop";
  return "replace";
}

/**
 * A thread's toast, after the thread on screen changed: one shown while you were there gains
 * "Open thread" once you leave; one that offered "Open thread" goes once you're there.
 */
export function threadToastChange(o: { visible: boolean; offersOpen: boolean; ownAction: boolean }): "offer-open" | "close" | "keep" {
  if (o.ownAction) return "keep";
  if (!o.visible && !o.offersOpen) return "offer-open";
  if (o.visible && o.offersOpen) return "close";
  return "keep";
}
