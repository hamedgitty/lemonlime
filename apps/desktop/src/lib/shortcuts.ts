/**
 * Keyboard shortcuts: what each does, its default keys, and the user's own choice
 * (UiPrefs.shortcuts). A combo is written like "mod+shift+[" where mod is ⌘ on macOS
 * and Ctrl elsewhere.
 */

export const SHORTCUTS = [
  { id: "new-thread", label: "New thread", group: "App", keys: "mod+n" },
  { id: "search", label: "Search threads", group: "App", keys: "mod+k" },
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
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** Keys that work everywhere and can't be changed. */
export const FIXED_SHORTCUTS: [string, string][] = [
  ["Enter", "Send"],
  ["Shift Enter", "New line"],
  ["Esc", "Stop the agent, or leave Settings"],
  ["/", "Search settings"],
];

export const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** The keys for a shortcut, the user's choice first. Empty means turned off. */
export function keysFor(id: ShortcutId, overrides: Record<string, string>): string {
  return overrides[id] ?? SHORTCUTS.find(s => s.id === id)!.keys;
}

/** A keydown as a combo string, or null for a bare modifier press. */
export function comboOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): string | null {
  const key = e.key.toLowerCase();
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
