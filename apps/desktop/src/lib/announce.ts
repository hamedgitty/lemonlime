/**
 * What a screen reader hears when another thread changes: it finished, failed, or its agent
 * needs you. Nothing about the thread on screen (you can see it) and nothing on first load
 * (that's no change); the app's effects only call this for changes they saw happen.
 */

export type ThreadChange = "finished" | "failed" | "needs-you";

export function announcement(change: ThreadChange, title: string): string {
  const name = title.trim() ? `“${title.trim()}”` : "A thread";
  if (change === "finished") return `${name} finished.`;
  if (change === "failed") return `${name} failed.`;
  return `${name} needs you.`;
}

/** Each change once: the same words again within this long are a repeat. */
export const REPEAT_MS = 3000;

/**
 * The words to say for a batch of changes, leaving out what was just said (`said`: words
 * to when, which this updates).
 */
export function freshAnnouncements(lines: readonly string[], said: Map<string, number>, now: number): string[] {
  for (const [line, at] of said) if (now - at >= REPEAT_MS) said.delete(line);
  const out: string[] = [];
  for (const line of lines) {
    if (said.has(line) || out.includes(line)) continue;
    said.set(line, now);
    out.push(line);
  }
  return out;
}
