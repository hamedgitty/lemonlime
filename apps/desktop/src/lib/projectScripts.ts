import { runnerHttpBase } from "@lemonlime/client";
import { ProjectScriptsResponse, type ResolvedScript, type ScriptKeybinding } from "@lemonlime/protocol";
import type { Connection } from "./useThreadSession.ts";

/**
 * The project's scripts (lemonlime.json), as the thread's runner reads them. The app only
 * ever names a script by id; its command stays on the runner's side.
 */

export type Script = ProjectScriptsResponse["scripts"][number] & ResolvedScript;

/** The runner's list, or null from a runner too old to know about scripts. */
export async function fetchProjectScripts(connection: Connection, fetchImpl: typeof fetch = fetch): Promise<ProjectScriptsResponse | null> {
  const res = await fetchImpl(`${runnerHttpBase(connection.url)}/project-scripts`, { headers: { authorization: `Bearer ${await connection.token()}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The runner answered with HTTP ${res.status}.`);
  const parsed = ProjectScriptsResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error("The runner sent scripts this app doesn't understand.");
  return parsed.data;
}

/** The script a shortcut runs: the first that asks for it. */
export function scriptForShortcut(scripts: readonly Script[], keybinding: ScriptKeybinding): Script | undefined {
  return scripts.find(s => s.keybinding === keybinding);
}

// ── The focused thread's scripts, for the command palette ──

let focused: { threadId: string; scripts: Script[] } | null = null;

/** The thread in front says which scripts it has (or clears them when it leaves). */
export function setFocusedScripts(threadId: string, scripts: Script[] | null): void {
  if (scripts) focused = { threadId, scripts };
  else if (focused?.threadId === threadId) focused = null;
}

export function focusedScripts(): Script[] {
  return focused?.scripts ?? [];
}

/** Ask the thread in front to run a script, by id or by its shortcut. */
export function requestScript(detail: { id: string } | { keybinding: ScriptKeybinding }): void {
  window.dispatchEvent(new CustomEvent("lemonlime:run-script", { detail }));
}
