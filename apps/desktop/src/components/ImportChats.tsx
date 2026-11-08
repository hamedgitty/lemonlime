import { useEffect, useMemo, useState } from "react";
import { FolderGit2, Plus } from "lucide-react";
import { HISTORY_AGENT_NAMES, importAgentSessions, scanAgentHistory, type HistoryAgent, type HistoryScan } from "../lib/history.ts";
import { relativeTime, repoName } from "../lib/format.ts";
import { inDesktopShell } from "../lib/native.ts";
import type { LocalThreadMeta } from "../lib/storage.ts";
import { Button, Spinner, cx } from "./ui.tsx";

const AGENTS: HistoryAgent[] = ["claude-code", "codex", "opencode"];
const PERIODS = [
  { days: 7, label: "last 7 days" },
  { days: 30, label: "last 30 days" },
  { days: 90, label: "last 90 days" },
  { days: 365, label: "last year" },
];

/**
 * "Import my Claude Code and Codex chats from the last 30 days": brings conversations from
 * the agents' own history into LemonLime as local threads you can carry on. The originals
 * are only read, never changed.
 */
export function ImportChats({
  runnerPath,
  projects,
  onImported,
  onAddProject,
  onDone,
  compact = false,
}: {
  runnerPath: string;
  projects: string[];
  onImported: (threads: LocalThreadMeta[]) => void;
  onAddProject: (path: string) => void;
  /** Shown as a Continue / Start empty button (setup). */
  onDone?: () => void;
  compact?: boolean;
}) {
  const [days, setDays] = useState(30);
  const [agents, setAgents] = useState<Set<HistoryAgent>>(new Set(AGENTS));
  const [scan, setScan] = useState<HistoryScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: { id: string; reason: string }[] } | null>(null);
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set());
  const shell = inDesktopShell();

  useEffect(() => {
    if (!shell) return;
    let live = true;
    setScanning(true);
    setError(null);
    scanAgentHistory(days, { limit: 500, ...(runnerPath ? { runnerPath } : {}) })
      .then(s => live && setScan(s))
      .catch(e => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setScanning(false));
    return () => {
      live = false;
    };
  }, [days, runnerPath, shell]);

  const sessions = useMemo(() => (scan?.sessions ?? []).filter(s => agents.has(s.agent) && !s.importedThreadId), [scan, agents]);
  const picked = sessions.filter(s => !unpicked.has(s.id));
  const byAgent = AGENTS.map(a => ({ a, n: picked.filter(s => s.agent === a).length })).filter(x => x.n > 0);
  const folders = useMemo(() => {
    const m = new Map<string, { path: string; sessions: number; lastUsed: string }>();
    for (const a of AGENTS)
      for (const f of scan?.agents[a]?.folders ?? []) {
        const prev = m.get(f.path);
        m.set(f.path, prev ? { ...prev, sessions: prev.sessions + f.sessions, lastUsed: prev.lastUsed > f.lastUsed ? prev.lastUsed : f.lastUsed } : { ...f });
      }
    return [...m.values()]
      .filter(f => !projects.includes(f.path))
      .sort((x, y) => y.lastUsed.localeCompare(x.lastUsed))
      .slice(0, 6);
  }, [scan, projects]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await importAgentSessions(
        picked.map(s => s.id),
        runnerPath ? { runnerPath } : {},
      );
      onImported(r.imported.map(i => i.thread));
      setResult({ imported: r.imported.length, skipped: r.skipped });
      setScan(s => (s ? { ...s, sessions: s.sessions.map(x => ({ ...x, ...(r.imported.some(i => i.id === x.id) ? { importedThreadId: "done" } : {}) })) } : s));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!shell) return <p className="text-[14px] text-ink-soft">Importing chats works in the desktop app.</p>;

  const toggleAgent = (a: HistoryAgent) =>
    setAgents(s => {
      const next = new Set(s);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[16px] leading-9">
        <span>Import my</span>
        {AGENTS.map(a => {
          const info = scan?.agents[a];
          const count = scan?.sessions.filter(s => s.agent === a && !s.importedThreadId).length ?? 0;
          return (
            <button
              key={a}
              type="button"
              aria-pressed={agents.has(a)}
              disabled={info ? !info.found : false}
              onClick={() => toggleAgent(a)}
              className={cx(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[14px] disabled:opacity-40",
                agents.has(a) ? "border-ink bg-ink text-cream" : "border-line-strong text-ink-soft hover:text-ink",
              )}
            >
              {HISTORY_AGENT_NAMES[a]}
              {scan && <span className="tabular-nums opacity-75">{count}</span>}
            </button>
          );
        })}
        <span>chats from the</span>
        <select
          aria-label="Period"
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="h-8 rounded-full border border-line-strong bg-paper px-3 text-[14px]"
        >
          {PERIODS.map(p => (
            <option key={p.days} value={p.days}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {scanning && (
        <p className="flex items-center gap-2 text-[14px] text-ink-soft">
          <Spinner /> Looking through your agents' history…
        </p>
      )}
      {scan && !scanning && sessions.length === 0 && (
        <p className="text-[14px] text-ink-soft">
          {AGENTS.some(a => scan.agents[a]?.found)
            ? "No chats in that period that aren't imported already."
            : "No Claude Code, Codex or OpenCode history found on this computer."}
        </p>
      )}
      {sessions.length > 0 && (
        <ul className={cx("scroll-thin flex flex-col overflow-y-auto rounded-xl border border-line bg-paper", compact ? "max-h-[240px]" : "max-h-[360px]")}>
          {sessions.map(s => (
            <li key={s.id} className="border-b border-line last:border-b-0">
              <label className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 hover:bg-cream">
                <input
                  type="checkbox"
                  checked={!unpicked.has(s.id)}
                  onChange={e =>
                    setUnpicked(u => {
                      const next = new Set(u);
                      if (e.target.checked) next.delete(s.id);
                      else next.add(s.id);
                      return next;
                    })
                  }
                  className="mt-1 size-4 accent-[var(--color-leaf)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{s.title || "Untitled chat"}</span>
                  <span className="block truncate text-[12.5px] text-ink-soft">
                    {HISTORY_AGENT_NAMES[s.agent]}, {s.cwd ? repoName(s.cwd) : "no folder"}, {s.messageCount}
                    {s.partial ? "+" : ""} messages, {relativeTime(s.updatedAt)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={busy || picked.length === 0} onClick={() => void run()}>
          {busy && <Spinner />}
          Import {picked.length} {picked.length === 1 ? "chat" : "chats"}
        </Button>
        {byAgent.length > 1 && <span className="text-[13.5px] text-ink-soft">{byAgent.map(x => `${x.n} ${HISTORY_AGENT_NAMES[x.a]}`).join(", ")}</span>}
        {onDone && (
          <Button variant="ghost" onClick={onDone}>
            {result ? "Continue" : "Start empty"}
          </Button>
        )}
      </div>
      {result && (
        <p role="status" className="text-[13.5px] text-leaf">
          Imported {result.imported} {result.imported === 1 ? "chat" : "chats"}. They're in the sidebar, ready to carry on.
          {result.skipped.length > 0 && (
            <span className="block text-ink-soft">
              Left out {result.skipped.length}: {result.skipped[0]!.reason}
            </span>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13.5px] text-danger">
          {error}
        </p>
      )}
      <p className="text-[12.5px] text-ink-faint">
        Your agents' own history is only read, never changed. Each chat becomes a thread on this computer, on a fresh branch.
      </p>

      {folders.length > 0 && (
        <section>
          <h3 className="mb-2 font-sans text-[13.5px] font-semibold tracking-normal text-ink-soft">Or add a recent folder</h3>
          <ul className="flex flex-col gap-1.5">
            {folders.map(f => (
              <li key={f.path} className="flex items-center gap-3 rounded-lg border border-line bg-paper px-3 py-2">
                <FolderGit2 aria-hidden="true" className="size-4 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{repoName(f.path)}</span>
                  <span className="block truncate font-mono text-[12px] text-ink-faint">{f.path}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => onAddProject(f.path)}>
                  <Plus aria-hidden="true" className="size-3.5" />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** How you work with each agent on this computer: sessions and a year of activity. */
export function AgentScans({ runnerPath }: { runnerPath: string }) {
  const [scan, setScan] = useState<HistoryScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!inDesktopShell()) return;
    scanAgentHistory(365, { limit: 1, ...(runnerPath ? { runnerPath } : {}) }).then(setScan, e => setError(String(e)));
  }, [runnerPath]);
  if (!inDesktopShell()) return <p className="text-[14px] text-ink-soft">Scans work in the desktop app.</p>;
  if (error)
    return (
      <p role="alert" className="text-[13.5px] text-danger">
        {error}
      </p>
    );
  if (!scan)
    return (
      <p className="flex items-center gap-2 text-[14px] text-ink-soft">
        <Spinner /> Reading your agents' history…
      </p>
    );
  return (
    <>
      <p className="mb-4 text-[14px] text-ink-soft">
        How you've worked with each agent on this computer over the past year, read from their own history. Nothing leaves this computer.
      </p>
      <div className="flex flex-col gap-3">
        {AGENTS.map(a => {
          const info = scan.agents[a];
          return (
            <section key={a} className="rounded-xl border border-line bg-paper p-4">
              <div className="flex items-baseline gap-3">
                <h3 className="flex-1 font-sans text-[15px] font-semibold tracking-normal">{HISTORY_AGENT_NAMES[a]}</h3>
                <span className="text-[13px] text-ink-soft tabular-nums">
                  {info?.found ? `${info.inRange} sessions this year, ${info.sessions} in all` : (info?.note ?? "Not used on this computer")}
                </span>
              </div>
              {info?.found && <Heatmap perDay={info.perDay} />}
              {info?.found && info.folders.length > 0 && (
                <p className="mt-2 truncate text-[12.5px] text-ink-soft">
                  Most used:{" "}
                  {[...info.folders]
                    .sort((x, y) => y.sessions - x.sessions)
                    .slice(0, 3)
                    .map(f => repoName(f.path))
                    .join(", ")}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function Heatmap({ perDay }: { perDay: Record<string, number> }) {
  const days: { key: string; n: number }[] = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 364 - start.getDay());
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push({ key, n: perDay[key] ?? 0 });
  }
  const max = Math.max(1, ...days.map(d => d.n));
  const shade = (n: number) =>
    n === 0 ? "bg-cream-deep" : n / max < 0.25 ? "bg-lime-soft" : n / max < 0.5 ? "bg-lime/60" : n / max < 0.75 ? "bg-lime" : "bg-lime-2";
  return (
    <div className="mt-3 overflow-x-auto">
      <div className="grid w-max grid-flow-col grid-rows-7 gap-[3px]" role="img" aria-label="Sessions per day over the past year">
        {days.map(d => (
          <span key={d.key} title={`${d.key}: ${d.n}`} className={cx("size-[10px] rounded-[2px]", shade(d.n))} />
        ))}
      </div>
    </div>
  );
}
