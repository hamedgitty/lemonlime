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
