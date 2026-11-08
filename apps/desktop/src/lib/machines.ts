import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * The user's other machines (a home server, a dev box, one on their Tailscale network),
 * reached over SSH with their own `~/.ssh/config` and agent. Kept in local storage on this
 * computer only. No passwords or keys are ever asked for or stored: just how to reach it.
 */

const KEY_MACHINES = "lemonlime:machines";
const MAX_RECENT_PATHS = 6;

export const Machine = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** A host from ~/.ssh/config, or user@host[:port]. */
  host: z.string().min(1),
  /** Path to lemonlime-runner there; empty means "on the PATH ssh sees". */
  runnerPath: z.string().default(""),
  /** Project folders used there, newest first. */
  recentPaths: z.array(z.string()).default([]),
});
export type Machine = z.infer<typeof Machine>;

const NAME_CHAR = /^[A-Za-z0-9._-]+$/;

/**
 * Why `host` can't be used, or null when it's fine. The same rules as the app's native side
 * (ssh.rs), which checks again: a host from your SSH config, `user@host`, `user@host:port`
 * or `user@[ipv6]:port`. Nothing that could become an ssh option or a second argument.
 */
export function hostProblem(host: string): string | null {
  const bad = "Enter a host from your SSH config, or user@host, optionally with :port.";
  if (!host || host.length > 255) return bad;
  if (host.startsWith("-")) return 'A host can\'t start with "-".';
  if (/[\s\p{Cc}]/u.test(host)) return "A host can't contain spaces or line breaks.";
  const at = host.split("@");
  if (at.length > 2) return bad;
  const user = at.length === 2 ? at[0]! : null;
  const rest = at.length === 2 ? at[1]! : at[0]!;
  if (user !== null && (!user || user.startsWith("-") || !NAME_CHAR.test(user))) return bad;
  let name: string;
  let port: string | null = null;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close < 0) return bad;
    name = rest.slice(1, close);
    if (!name || !/^[0-9A-Fa-f:.]+$/.test(name)) return bad;
    const after = rest.slice(close + 1);
    if (after) {
      if (!after.startsWith(":")) return bad;
      port = after.slice(1);
    }
  } else {
    const colon = rest.indexOf(":");
    name = colon < 0 ? rest : rest.slice(0, colon);
    if (colon >= 0) port = rest.slice(colon + 1);
    if (!name || name.startsWith("-") || name.startsWith(".") || !NAME_CHAR.test(name)) return bad;
  }
  if (port !== null) {
    const n = Number(port);
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) return "The port must be a number from 1 to 65535.";
  }
  return null;
}

/** Why a path typed for that machine can't be used, or null. */
export function remotePathProblem(path: string, what: string): string | null {
  if (!path) return `Enter the ${what} on that machine.`;
  // eslint-disable-next-line no-control-regex
  if (path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return `The ${what} can't contain line breaks or control characters.`;
  if (path.startsWith("-")) return `The ${what} can't start with "-".`;
  return null;
}

export interface MachineInput {
  name: string;
  host: string;
  runnerPath: string;
}

/** Checks and tidies what was typed; returns the problem, or the clean values. */
export function cleanMachineInput(input: MachineInput): { error: string } | { value: MachineInput } {
  const host = input.host.trim();
  const runnerPath = input.runnerPath.trim();
  const name = input.name.trim() || host;
  const problem = hostProblem(host) ?? (runnerPath ? remotePathProblem(runnerPath, "runner path") : null);
  if (problem) return { error: problem };
  if (name.length > 60) return { error: "Keep the name under 60 characters." };
  return { value: { name, host, runnerPath } };
}

export function addMachine(list: readonly Machine[], input: MachineInput, id = newMachineId()): Machine[] {
  return [...list, { id, ...input, recentPaths: [] }];
}

export function updateMachine(list: readonly Machine[], id: string, input: MachineInput): Machine[] {
  return list.map(m => (m.id === id ? { ...m, ...input } : m));
}

export function removeMachine(list: readonly Machine[], id: string): Machine[] {
  return list.filter(m => m.id !== id);
}

/** Puts `path` first in the machine's recent project folders. */
export function rememberPath(list: readonly Machine[], id: string, path: string): Machine[] {
  return list.map(m => (m.id === id ? { ...m, recentPaths: [path, ...m.recentPaths.filter(p => p !== path)].slice(0, MAX_RECENT_PATHS) } : m));
}

function newMachineId(): string {
  return `m-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/** The last part of a path typed for another machine, for labels. */
export function remoteFolderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

// ── Storage ────────────────────────────────────────────────

export function loadMachines(): Machine[] {
  let raw: unknown;
  try {
    const text = localStorage.getItem(KEY_MACHINES);
    raw = text == null ? [] : JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Machine[] = [];
  for (const item of raw) {
    const m = Machine.safeParse(item);
    // A machine whose host no longer passes the checks is dropped rather than used.
    if (m.success && hostProblem(m.data.host) === null) out.push(m.data);
  }
  return out;
}

const listeners = new Set<() => void>();
let cache: Machine[] | null = null;

export function saveMachines(list: readonly Machine[]): void {
  try {
    localStorage.setItem(KEY_MACHINES, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the list still holds for this session */
  }
  cache = [...list];
  for (const l of listeners) l();
}

function snapshot(): Machine[] {
  if (cache === null) cache = loadMachines();
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The machines, kept current wherever they are changed. */
export function useMachines(): Machine[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The machine a thread runs on, by id (from a fresh read, outside React). */
export function findMachine(id: string): Machine | undefined {
  return snapshot().find(m => m.id === id);
}
