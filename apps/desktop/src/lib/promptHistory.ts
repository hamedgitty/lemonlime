/**
 * Up and Down in the composer step through the prompts sent earlier in the thread, like a
 * shell. Unsent drafts are kept per thread in local storage, so switching threads (or
 * restarting the app) doesn't lose them.
 */

export interface HistoryState {
  /** Which earlier prompt is showing, counting back from the newest (0); null when not browsing. */
  index: number | null;
  /** What was in the box before browsing started, restored when stepping past the newest. */
  saved: string;
}

export const HISTORY_IDLE: HistoryState = { index: null, saved: "" };

/**
 * One step through `prompts` (oldest first). Returns the text to show and the new state,
 * or null when the key should do its usual thing (move the caret).
 * Browsing starts only from an empty box, and only while the caret is on the first line
 * (Up) or last line (Down) of what's showing, so editing a long prompt still works.
 */
export function stepHistory(
  prompts: readonly string[],
  state: HistoryState,
  dir: "up" | "down",
  box: { text: string; caret: number },
): { text: string; state: HistoryState } | null {
  if (prompts.length === 0) return null;
  const onFirstLine = !box.text.slice(0, box.caret).includes("\n");
  const onLastLine = !box.text.slice(box.caret).includes("\n");
  if (state.index === null) {
    if (dir !== "up" || box.text.trim() !== "") return null;
    return { text: prompts[prompts.length - 1]!, state: { index: 0, saved: box.text } };
  }
  // Edited since it was recalled: it's a new draft now, so the keys move the caret again.
  if (box.text !== prompts[prompts.length - 1 - state.index]) return null;
  if (dir === "up") {
    if (!onFirstLine || state.index >= prompts.length - 1) return null;
    const index = state.index + 1;
    return { text: prompts[prompts.length - 1 - index]!, state: { ...state, index } };
  }
  if (!onLastLine) return null;
  if (state.index === 0) return { text: state.saved, state: HISTORY_IDLE };
  const index = state.index - 1;
  return { text: prompts[prompts.length - 1 - index]!, state: { ...state, index } };
}

/** Each prompt once, newest copy kept, oldest first. */
export function uniquePrompts(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.reverse();
}

// ── Drafts ───────────────────────────────────────────────

const draftKey = (key: string) => `lemonlime:draft:${key}`;
/** Drafts longer than this aren't kept (local storage is small). */
const MAX_DRAFT = 100_000;

export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(draftKey(key)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(key: string, text: string): void {
  try {
    if (!text.trim() || text.length > MAX_DRAFT) localStorage.removeItem(draftKey(key));
    else localStorage.setItem(draftKey(key), text);
  } catch {
    /* storage full or blocked: the draft lives until the app closes */
  }
}
