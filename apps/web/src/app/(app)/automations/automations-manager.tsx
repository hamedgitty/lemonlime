"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { AGENT_CAPABILITIES, nextRun, parseSchedule, type AgentKind, type ReasoningLevel } from "@lemonlime/protocol";
import { apiFetch } from "@/lib/api-client.ts";
import { timeAgo } from "@/components/status-pill.tsx";

interface Run {
  id: string;
  status: "started" | "skipped" | "failed";
  ranAt: string;
  threadId: string | null;
  detail: string | null;
}

export interface AutomationInfo {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  agent: { kind: AgentKind; model?: string; reasoning?: ReasoningLevel };
  repo: { url: string; baseBranch: string };
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  recentRuns?: Run[];
}

const AGENTS: { kind: AgentKind; label: string }[] = [
  { kind: "claude-code", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "opencode", label: "OpenCode" },
];

const PRESETS = [
  { label: "Every weekday at 9:00", cron: "0 9 * * 1-5" },
  { label: "Every night at 3:00", cron: "0 3 * * *" },
  { label: "Every Monday at 8:00", cron: "0 8 * * 1" },
  { label: "Every hour", cron: "0 * * * *" },
];

const when = (iso: string | null, tz: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz })
    : "Not scheduled";

const RUN_LABEL: Record<Run["status"], string> = { started: "Started", skipped: "Skipped", failed: "Failed" };

/** Create, pause, delete and look back at automations. Times show in each automation's own time zone. */
export function AutomationsManager({ initial }: { initial: AutomationInfo[] }) {
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [form, setForm] = useState({
    name: "",
    schedule: PRESETS[0]!.cron,
    agent: "claude-code" as AgentKind,
    model: "",
    reasoning: "" as ReasoningLevel | "",
    repoUrl: "",
    baseBranch: "main",
    prompt: "",
  });
  const [busy, setBusy] = useState(false);
  const caps = AGENT_CAPABILITIES[form.agent];

  const preview = useMemo(() => {
    try {
      parseSchedule(form.schedule);
      const next = nextRun(form.schedule, new Date(), zone);
      return { ok: true as const, text: next ? `Next: ${when(next.toISOString(), zone)} (${zone})` : "That schedule never comes round." };
    } catch (e) {
      return { ok: false as const, text: e instanceof Error ? e.message : String(e) };
    }
  }, [form.schedule, zone]);

  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ automation: AutomationInfo }>("/api/automations", {
      method: "POST",
      body: {
        name: form.name,
        schedule: form.schedule,
        timezone: zone,
        agent: { kind: form.agent, ...(form.model.trim() ? { model: form.model.trim() } : {}), ...(form.reasoning ? { reasoning: form.reasoning } : {}) },
        repo: { url: form.repoUrl.trim(), baseBranch: form.baseBranch.trim() || "main" },
        prompt: form.prompt,
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setList(l => [...l, { ...res.data.automation, recentRuns: [] }]);
    set({ name: "", prompt: "" });
  }

  async function toggle(a: AutomationInfo) {
    setError(null);
    const res = await apiFetch<{ automation: AutomationInfo }>(`/api/automations/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } });
    if (!res.ok) return setError(res.message);
    setList(l => l.map(x => (x.id === a.id ? { ...x, ...res.data.automation } : x)));
  }

  async function remove(a: AutomationInfo) {
    if (!window.confirm(`Delete "${a.name}"? Threads it already started stay.`)) return;
    const res = await apiFetch(`/api/automations/${a.id}`, { method: "DELETE" });
    if (!res.ok) return setError(res.message);
    setList(l => l.filter(x => x.id !== a.id));
  }

  const now = Date.now();
  return (
    <div className="space-y-8">
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {list.length > 0 && (
        <ul className="space-y-3">
          {list.map(a => (
            <li key={a.id} className="card p-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{a.name}</p>
                  <p className="mt-0.5 text-sm text-muted">
                    <span className="font-mono">{a.schedule}</span> ({a.timezone}), {AGENTS.find(x => x.kind === a.agent.kind)?.label ?? a.agent.kind} on{" "}
                    <span className="font-mono">{a.repo.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}</span>
                  </p>
                  <p className="mt-1 text-sm">{a.enabled ? `Next run ${when(a.nextRunAt, a.timezone)}` : "Paused"}</p>
                </div>
                <button type="button" className="btn-ghost h-8" onClick={() => toggle(a)}>
                  {a.enabled ? "Pause" : "Resume"}
                </button>
                <button type="button" className="btn-danger h-8" onClick={() => remove(a)}>
                  Delete
                </button>
              </div>
              {a.recentRuns && a.recentRuns.length > 0 && (
                <ul aria-label="Recent runs" className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
                  {a.recentRuns.map(r => (
                    <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                      <span className={r.status === "started" ? "text-leaf" : r.status === "skipped" ? "text-amber-800" : "text-red-800"}>
                        {RUN_LABEL[r.status]}
                      </span>
                      <span className="text-muted">{timeAgo(r.ranAt, now)}</span>
                      <span className="min-w-0 flex-1 truncate text-muted" title={r.detail ?? undefined}>
                        {r.detail}
                      </span>
                      {r.threadId && (
                        <Link href={`/threads/${r.threadId}`} className="text-leaf underline-offset-2 hover:underline">
                          Open thread
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="card space-y-4 p-6">
        <h2 className="text-xl font-semibold">New automation</h2>
        <div>
          <label htmlFor="auto-name" className="label">
            Name
          </label>
          <input
            id="auto-name"
            required
            maxLength={120}
            className="field"
            placeholder="Nightly dependency bump"
            value={form.name}
            onChange={e => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="auto-schedule" className="label">
            When
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Common schedules"
              className="field w-auto"
              value={PRESETS.find(p => p.cron === form.schedule)?.cron ?? ""}
              onChange={e => e.target.value && set({ schedule: e.target.value })}
            >
              {PRESETS.map(p => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
              <option value="">Custom…</option>
            </select>
            <input
              id="auto-schedule"
              required
              className="field min-w-0 flex-1 font-mono"
              value={form.schedule}
              onChange={e => set({ schedule: e.target.value })}
              aria-describedby="auto-schedule-help"
              aria-invalid={preview.ok ? undefined : true}
            />
          </div>
          <p id="auto-schedule-help" className={`mt-1 text-sm ${preview.ok ? "text-muted" : "text-red-800"}`}>
            {preview.text}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="auto-agent" className="label">
              Agent
            </label>
            <select id="auto-agent" className="field" value={form.agent} onChange={e => set({ agent: e.target.value as AgentKind, reasoning: "" })}>
              {AGENTS.map(a => (
                <option key={a.kind} value={a.kind}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="auto-model" className="label">
              Model <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="auto-model"
              className="field font-mono"
              list="auto-models"
              placeholder="Agent's default"
              value={form.model}
              onChange={e => set({ model: e.target.value })}
            />
            <datalist id="auto-models">
              {caps.models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </div>
        </div>
        {caps.reasoning.length > 0 && (
          <div>
            <label htmlFor="auto-reasoning" className="label">
              Thinking
            </label>
            <select
              id="auto-reasoning"
              className="field w-auto"
              value={form.reasoning}
              onChange={e => set({ reasoning: e.target.value as ReasoningLevel | "" })}
            >
              <option value="">Default</option>
              {caps.reasoning.map(r => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div>
            <label htmlFor="auto-repo" className="label">
              Repository
            </label>
            <input
              id="auto-repo"
              required
              className="field font-mono"
              placeholder="https://github.com/acme/app"
              value={form.repoUrl}
              onChange={e => set({ repoUrl: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="auto-base" className="label">
              Branch
            </label>
            <input id="auto-base" required className="field font-mono" value={form.baseBranch} onChange={e => set({ baseBranch: e.target.value })} />
          </div>
        </div>
        <div>
          <label htmlFor="auto-prompt" className="label">
            What the agent should do
          </label>
          <textarea
            id="auto-prompt"
            required
            rows={4}
            maxLength={50_000}
            className="field h-auto py-2"
            placeholder="Update the dependencies, run the tests, and open a pull request if anything changed."
            value={form.prompt}
            onChange={e => set({ prompt: e.target.value })}
          />
        </div>
        <button type="submit" className="btn-primary h-10" disabled={busy || !preview.ok}>
          {busy ? "Saving..." : "Create automation"}
        </button>
      </form>
    </div>
  );
}
