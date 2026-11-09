/**
 * Where you were reading in each thread, so coming back to one picks up there instead of
 * at the bottom. A place is the row at the top of the view and how far it sat from the
 * top, which survives rows above it changing height. The last 100 threads are kept.
 */

export interface ScrollPlace {
  /** The timeline row (its key) at the top of the view. */
  key: string;
  /** Its top edge, in px below the top of the view (negative once scrolled partly past). */
  offset: number;
}

export const SCROLL_MEMORY_LIMIT = 100;
const KEY = "lemonlime:scroll-places";

type Places = [threadId: string, place: ScrollPlace][];

/** The list with `threadId` set to `place` (or forgotten, for null), newest last, at most `limit` long. */
export function rememberPlace(list: Places, threadId: string, place: ScrollPlace | null, limit = SCROLL_MEMORY_LIMIT): Places {
  const rest = list.filter(([id]) => id !== threadId);
  if (place) rest.push([threadId, place]);
  return rest.slice(-limit);
}

function load(): Places {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is Places[number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1]?.key === "string" && typeof e[1]?.offset === "number",
    );
  } catch {
    return [];
  }
}

/** Where the thread was left, or null (read from the bottom). */
export function loadScrollPlace(threadId: string): ScrollPlace | null {
  return load().find(([id]) => id === threadId)?.[1] ?? null;
}

/** Keeps where the thread was left; null means at the bottom, following along. */
export function saveScrollPlace(threadId: string, place: ScrollPlace | null): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rememberPlace(load(), threadId, place)));
  } catch {
    /* storage full or blocked: the place just isn't kept */
  }
}
