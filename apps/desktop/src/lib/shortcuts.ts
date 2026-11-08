/**
 * Keyboard shortcuts: what each does, its default keys, and the user's own choice
 * (UiPrefs.shortcuts). A combo is written like "mod+shift+[" where mod is ⌘ on macOS
 * and Ctrl elsewhere.
 */

export const SHORTCUTS = [
  { id: "new-thread", label: "New thread", group: "App", keys: "mod+n" },
  { id: "search", label: "Search threads and commands", group: "App", keys: "mod+k" },
  { id: "settings", label: "Settings", group: "App", keys: "mod+," },
  { id: "toggle-sidebar", label: "Show or hide the sidebar", group: "App", keys: "mod+\\" },
  { id: "back", label: "Back", group: "App", keys: "mod+[" },
  { id: "forward", label: "Forward", group: "App", keys: "mod+]" },
  { id: "skills", label: "Skills", group: "App", keys: "mod+shift+s" },
  { id: "automations", label: "Automations", group: "App", keys: "mod+shift+l" },
  { id: "prev-thread", label: "Previous thread", group: "Threads", keys: "mod+shift+[" },
  { id: "next-thread", label: "Next thread", group: "Threads", keys: "mod+shift+]" },
  { id: "pin-thread", label: "Pin or unpin this thread", group: "Threads", keys: "mod+shift+p" },
  { id: "archive-thread", label: "Archive this thread", group: "Threads", keys: "mod+shift+backspace" },
  { id: "last-pinned", label: "Go to the last pinned thread", group: "Threads", keys: "mod+e" },
  { id: "right-panel", label: "Show or hide the side panel", group: "Threads", keys: "mod+shift+\\" },
  { id: "find", label: "Find in this thread", group: "Threads", keys: "mod+f" },
  // ⌘\ already shows or hides the sidebar, so splitting uses ⌘D.
  { id: "split-right", label: "Split to the right", group: "Split view", keys: "mod+d" },
  { id: "maximise-pane", label: "Maximise or restore this pane", group: "Split view", keys: "mod+shift+enter" },
  { id: "focus-pane-1", label: "Go to pane 1", group: "Split view", keys: "mod+1" },
  { id: "focus-pane-2", label: "Go to pane 2", group: "Split view", keys: "mod+2" },
  { id: "focus-pane-3", label: "Go to pane 3", group: "Split view", keys: "mod+3" },
  { id: "focus-pane-4", label: "Go to pane 4", group: "Split view", keys: "mod+4" },
  { id: "focus-pane-5", label: "Go to pane 5", group: "Split view", keys: "mod+5" },
  { id: "focus-pane-6", label: "Go to pane 6", group: "Split view", keys: "mod+6" },
  { id: "quick-open", label: "Open a file in the side panel", group: "Threads", keys: "mod+p" },
  { id: "reopen-tab", label: "Reopen the last closed panel tab", group: "Threads", keys: "mod+shift+t" },
  // Only while the message box has focus (see ModelControl).
  { id: "cycle-effort", label: "Cycle the agent's effort, in the message box", group: "Threads", keys: "alt+t" },
] as const;

/** Shortcuts that only work while typing a message, so they're not commands in the palette. */
export const COMPOSER_SHORTCUTS: readonly ShortcutId[] = ["cycle-effort"];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** Keys that work everywhere and can't be changed. */
export const FIXED_SHORTCUTS: [string, string][] = [
  ["Enter", "Send"],
  ["Shift Enter", "New line"],
  ["Alt (⌥) Enter", "Send once the agent's subagents finish"],
  ["Esc", "Stop the agent, or leave Settings"],
  ["↑ ↓", "Earlier prompts, in an empty message box"],
  ["/", "Agent commands, at the start of a message"],
  ["@", "Mention a file in the thread's project"],
  ["/", "Search settings"],
];

export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** The keys for a shortcut, the user's choice first. Empty means turned off. */
export function keysFor(id: ShortcutId, overrides: Record<string, string>): string {
  return overrides[id] ?? SHORTCUTS.find(s => s.id === id)!.keys;
}

/** A keydown as a combo string, or null for a bare modifier press. */
export function comboOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { code?: string }): string | null {
  // Alt (⌥) changes the character on macOS (⌥T types "†"), so letters come from the key's place.
  const key = e.altKey && e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (["meta", "control", "shift", "alt"].includes(key)) return null;
  const parts: string[] = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (IS_MAC && e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  // Shift changes some keys ("{" for "["); keep the unshifted name.
  const unshifted: Record<string, string> = { "{": "[", "}": "]", "|": "\\", "<": ",", ">": "." };
  parts.push(unshifted[key] ?? (key === " " ? "space" : key));
  return parts.join("+");
}

/** Which shortcut a keydown means, if any. */
export function matchShortcut(e: KeyboardEvent, overrides: Record<string, string>): ShortcutId | null {
  const combo = comboOf(e);
  if (!combo) return null;
  for (const s of SHORTCUTS) if (keysFor(s.id, overrides) === combo) return s.id;
  return null;
}

/** "mod+shift+[" → ["⌘", "⇧", "["] (or Ctrl names elsewhere). */
export function keyCaps(combo: string): string[] {
  if (!combo) return [];
  const names: Record<string, string> = IS_MAC
    ? { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", backspace: "⌫", enter: "↩", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", space: "Space" }
    : {
        mod: "Ctrl",
        shift: "Shift",
        alt: "Alt",
        backspace: "Backspace",
        enter: "Enter",
        arrowup: "↑",
        arrowdown: "↓",
        arrowleft: "←",
        arrowright: "→",
        space: "Space",
      };
  return combo.split("+").map(p => names[p] ?? (p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)));
}

/** A combo must use ⌘/Ctrl or Alt, so plain typing never triggers one. */
export function validCombo(combo: string): boolean {
  const parts = combo.split("+");
  return parts.length >= 2 && (parts.includes("mod") || parts.includes("alt") || parts.includes("ctrl"));
}

/** Turn a shortcut off: it stays off (an empty combo) until it's reset or given new keys. */
export function clearShortcut(overrides: Record<string, string>, id: ShortcutId): Record<string, string> {
  return { ...overrides, [id]: "" };
}

/** Give a shortcut new keys; its own default keys need no override. */
export function setShortcut(overrides: Record<string, string>, id: ShortcutId, combo: string): Record<string, string> {
  const next = { ...overrides };
  if (combo === SHORTCUTS.find(s => s.id === id)!.keys) delete next[id];
  else next[id] = combo;
  return next;
}

/** Back to the default keys. */
export function resetShortcut(overrides: Record<string, string>, id: ShortcutId): Record<string, string> {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/**
 * Where a shortcut's button is on screen, for the hints shown while ⌘ (Ctrl) is held: a
 * CSS selector, and optionally the button's own text when the selector alone is too broad.
 * Any element can also say `data-shortcut="<id>"`.
 */
export const SHORTCUT_TARGETS: { id: ShortcutId; selector: string; text?: string }[] = [
  { id: "new-thread", selector: 'nav[aria-label="LemonLime"] button', text: "New thread" },
  { id: "search", selector: 'nav[aria-label="LemonLime"] button', text: "Search threads" },
  { id: "skills", selector: 'nav[aria-label="LemonLime"] button', text: "Skills" },
  { id: "automations", selector: 'nav[aria-label="LemonLime"] button', text: "Automations" },
  { id: "settings", selector: 'button[aria-label="Settings"]' },
  { id: "toggle-sidebar", selector: 'button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]' },
  { id: "back", selector: 'button[aria-label="Back"]' },
  { id: "forward", selector: 'button[aria-label="Forward"]' },
  { id: "right-panel", selector: 'button[aria-label="Side panel"]' },
];
