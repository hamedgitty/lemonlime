import type { ThreadStatus } from "@lemonlime/protocol";

const STYLES: Record<ThreadStatus, { label: string; className: string; dot: string }> = {
  provisioning: { label: "Starting", className: "bg-lemon/40 text-ink", dot: "bg-[#c9a800] animate-pulse" },
  idle: { label: "Ready", className: "bg-lime/30 text-leaf", dot: "bg-leaf" },
  running: { label: "Working", className: "bg-lime text-ink", dot: "bg-leaf animate-pulse" },
  paused: { label: "Paused", className: "bg-ink/8 text-muted", dot: "bg-muted" },
  stopped: { label: "Closed", className: "border border-line text-muted", dot: "bg-line" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800", dot: "bg-red-600" },
};

export function StatusPill({ status }: { status: ThreadStatus }) {
  const s = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${s.className}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  acp: "ACP agent",
};

/** "github.com/acme/app.git" → "acme/app" */
export function repoName(url: string): string {
  const cleaned = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join("/") || url;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
