import { shortPath, type AgentKind, type ThreadStatus } from "@lemonlime/protocol";

export const AGENT_LABELS: Record<AgentKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  acp: "ACP agent",
};

/** Status shown in the UI. `offline` means a local thread whose runner is not running. */
export type DisplayStatus = ThreadStatus | "offline";

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  provisioning: "Starting up",
  idle: "Waiting for you",
  running: "Working",
  paused: "Paused",
  stopped: "Stopped",
  failed: "Failed",
  offline: "Not running",
};

/** Last path segment of a local path or clone URL. */
export function repoName(pathOrUrl: string): string {
  const cleaned = pathOrUrl
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/, "");
  const parts = cleaned.split(/[\\/:]/).filter(Boolean);
  return parts[parts.length - 1] ?? pathOrUrl;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A short title from the first line of a prompt. */
export function titleFromPrompt(prompt: string, max = 60): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Pretty-prints tool input/output: strings as-is, everything else as JSON. */
export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export { shortPath };

/** One-line summary of a tool call's input for the collapsed row. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input === "string") return firstLine(input);
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return k === "file_path" || k === "path" ? shortPath(v.trim().split("\n")[0] ?? "") : firstLine(v);
      if (Array.isArray(v) && v.every(x => typeof x === "string")) return firstLine(v.join(" "));
    }
  }
  return "";
}

function firstLine(s: string): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
