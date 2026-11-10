import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ComputerRequest } from "@lemonlime/protocol";

/** What a cloud thread's agent may do on this computer. Off unless the user says otherwise. */
export type ComputerLevel = "off" | "read" | "ask" | "full";

export const COMPUTER_LEVELS: { value: ComputerLevel; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "The agent can't reach this computer" },
  { value: "read", label: "Read-only", hint: "Reads files and lists folders; asks before files that usually hold keys or passwords" },
  { value: "ask", label: "Ask first", hint: "Asks you before each request" },
  { value: "full", label: "Full", hint: "Reads, lists and runs commands without asking" },
];

/**
 * A string shown exactly as it is: control characters, invisible ones (zero-width, bidi
 * overrides) and anything outside plain ASCII are written as escapes, so look-alike
 * letters and hidden text can't disguise what will run.
 */
export function shownExactly(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp > 0x7e) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}

export function describeRequest(r: ComputerRequest): string {
  if (r.op === "read_file") return `Read the file ${shownExactly(r.path)}`;
  if (r.op === "list_dir") return `List the folder ${shownExactly(r.path)}`;
  return `Run this command${r.cwd ? ` in ${shownExactly(r.cwd)}` : " in your home folder"}:\n\n${shownExactly(r.command)}`;
}

/** Whether the setting allows a request outright, needs asking, or refuses it. */
export function decide(level: ComputerLevel, r: ComputerRequest): "allow" | "ask" | "refuse" {
  if (level === "off") return "refuse";
  if (level === "read") return r.op === "run_command" ? "refuse" : "allow";
  if (level === "ask") return "ask";
  return "allow";
}

/**
 * Answer one request. In the desktop app the native side has the final say: it checks the
 * thread's level again and asks in its own dialog at "ask first", so code in this window
 * can't grant itself access. Here the level only refuses early.
 */
export async function answerComputerRequest(
  level: ComputerLevel,
  r: ComputerRequest,
  ask: (question: string) => Promise<boolean>,
  threadId = "",
): Promise<{ ok: boolean; output: string }> {
  const verdict = decide(level, r);
  if (verdict === "refuse") {
    return {
      ok: false,
      output:
        level === "off" ? "The user hasn't given this thread access to their computer." : "Not allowed: this thread can only read files and list folders.",
    };
  }
  if (!isTauri()) {
    if (verdict === "ask" && !(await ask(`A cloud agent wants to:\n\n${describeRequest(r)}\n\nAllow it once?`)))
      return { ok: false, output: "The user said no." };
    return { ok: false, output: "Only the desktop app can do this." };
  }
  try {
    const output =
      r.op === "read_file"
        ? await invoke<string>("computer_read_file", { threadId, path: r.path })
        : r.op === "list_dir"
          ? await invoke<string>("computer_list_dir", { threadId, path: r.path })
          : await invoke<string>("computer_run_command", { threadId, command: r.command, cwd: r.cwd ?? null });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: String(err) };
  }
}

/** Every cloud thread's level, as the desktop app's native side keeps them. */
export async function loadComputerAccess(): Promise<Record<string, ComputerLevel> | null> {
  if (!isTauri()) return null;
  return invoke<Record<string, ComputerLevel>>("computer_access_levels").catch(() => null);
}

/**
 * Change a thread's level. Raising it is confirmed by the person in a native dialog; the
 * level in force afterwards comes back (unchanged if they said no).
 */
export async function setComputerAccess(threadId: string, level: ComputerLevel): Promise<ComputerLevel> {
  if (!isTauri()) return level;
  return invoke<ComputerLevel>("computer_set_access", { threadId, level });
}
