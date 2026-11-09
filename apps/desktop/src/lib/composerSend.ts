/**
 * Deciding whether a message can go, so the composer empties itself only once one did.
 * A message that can't go stays in the box, with its draft, exactly as typed.
 */

/** Why the message can't be sent from the composer right now, or null when it can. */
export function sendBlocker(s: { uploading: boolean }): string | null {
  if (s.uploading) return "Wait for the attached files to finish uploading.";
  return null;
}

/**
 * Where a message goes: straight to the runner while connected, through the control plane
 * for a cloud thread (which wakes a paused sandbox), or nowhere (null) for an empty
 * message or a local thread with no runner.
 */
export function sendRoute(text: string, connected: boolean, mode: "local" | "cloud"): "runner" | "wake" | null {
  if (!text.trim()) return null;
  if (connected) return "runner";
  return mode === "cloud" ? "wake" : null;
}

/** Which key sends: Enter, ⌘Enter (Ctrl+Enter), or ⌘Enter once the message runs over more than one line. */
export type SendKey = "enter" | "mod-enter" | "mod-enter-multiline";

/**
 * What an Enter press does in the message box: send, hold (⌥Enter, sent once subagents
 * finish), or start a new line. ⌘Enter always sends; Shift+Enter is always a new line.
 */
export function enterAction(
  e: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  sendKey: SendKey,
  text: string,
): "send" | "hold" | "newline" {
  if (e.metaKey || e.ctrlKey) return "send";
  if (e.shiftKey) return "newline";
  if (e.altKey) return "hold";
  if (sendKey === "mod-enter") return "newline";
  if (sendKey === "mod-enter-multiline" && text.includes("\n")) return "newline";
  return "send";
}

/** How to say which key sends, for the send button's tooltip. */
export function sendKeyLabel(sendKey: SendKey, text: string, mod: string): string {
  return enterAction({ shiftKey: false, altKey: false, metaKey: false, ctrlKey: false }, sendKey, text) === "send" ? "Enter" : `${mod}Enter`;
}
