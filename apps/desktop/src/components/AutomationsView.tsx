import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlarmClock, Pause, Play, Trash2 } from "lucide-react";
import { AGENT_CAPABILITIES, nextRun, parseSchedule, type AgentKind } from "@lemonlime/protocol";
import type { AutomationInfo, CloudApi } from "../lib/cloud.ts";
import { AGENT_LABELS, repoName } from "../lib/format.ts";
import { confirmAction } from "../lib/native.ts";
import { Button, SegmentedControl, Spinner, TextInput, cx } from "./ui.tsx";

const PRESETS = [
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Nightly 3:00", cron: "0 3 * * *" },
  { label: "Mondays 8:00", cron: "0 8 * * 1" },
  { label: "Hourly", cron: "0 * * * *" },
];

const when = (iso: string | null, tz: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz })
    : "Not scheduled";

/**
 * Automations: a prompt that starts a new cloud thread on a schedule. They run in the
 * cloud whether or not this app is open; a run the plan can't cover is skipped.
 */
export function AutomationsView({
  cloudApi,
  onConnectCloud,
  onOpenThread,
}: {
  cloudApi: CloudApi | null;
  onConnectCloud: () => void;
  onOpenThread: (id: string) => void;
}) {
  const [list, setList] = useState<AutomationInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [form, setForm] = useState({ name: "", schedule: PRESETS[0]!.cron, agent: "claude-code" as AgentKind, repoUrl: "", baseBranch: "main", prompt: "" });
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof form>) => setForm(f => ({ ...f, ...p }));

  const load = useCallback(() => {
    if (!cloudApi) return;
    cloudApi.listAutomations().then(setList, e => setError(e instanceof Error ? e.message : String(e)));
  }, [cloudApi]);
  useEffect(load, [load]);

  const preview = useMemo(() => {
    try {
      parseSchedule(form.schedule);
      const next = nextRun(form.schedule, new Date(), zone);
      return { ok: true, text: next ? `Next: ${when(next.toISOString(), zone)}` : "That schedule never comes round." };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }, [form.schedule, zone]);

  if (!cloudApi) {
    return (
      <main className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-md text-center">
          <AlarmClock aria-hidden="true" className="mx-auto mb-3 size-6 text-leaf" />
          <h1 className="font-sans text-[18px] font-semibold tracking-normal">Automations run in the cloud</h1>
          <p className="mt-2 text-[14px] text-ink-soft">
            Run a prompt on a schedule, like a nightly dependency bump, even with your laptop closed. Connect LemonLime Cloud to set them up.
          </p>
          <Button className="mt-4" variant="primary" onClick={onConnectCloud}>
            Connect LemonLime Cloud
          </Button>
        </div>
      </main>
    );
  }

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await cloudApi.createAutomation({
        name: form.name.trim(),
        schedule: form.schedule.trim(),
        timezone: zone,
        agent: { kind: form.agent },
        repo: { url: form.repoUrl.trim(), baseBranch: form.baseBranch.trim() || "main" },
        prompt: form.prompt.trim(),
      });
      setList(l => [...(l ?? []), { ...a, recentRuns: [] }]);
      set({ name: "", prompt: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (a: AutomationInfo) => {
    try {
      const u = await cloudApi.updateAutomation(a.id, { enabled: !a.enabled });
      setList(l => l?.map(x => (x.id === a.id ? { ...x, ...u } : x)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const remove = async (a: AutomationInfo) => {
    if (!(await confirmAction(`Delete "${a.name}"? Threads it already started stay.`))) return;
    try {
      await cloudApi.deleteAutomation(a.id);
      setList(l => l?.filter(x => x.id !== a.id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-10">
        <h1 className="font-display text-[26px] font-semibold tracking-[-0.02em]">Automations</h1>
        <p className="mt-1 text-[14px] text-ink-soft">
          A prompt that starts a new cloud thread on a schedule. They run in the cloud whether or not this app is open.
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[13.5px]">
            {error}
          </p>
        )}
        {list === null ? (
          <p className="mt-6 flex items-center gap-2 text-[14px] text-ink-soft">
            <Spinner /> Loading…
          </p>
        ) : (
          list.length > 0 && (
            <ul className="mt-6 flex flex-col gap-3">
              {list.map(a => (
                <li key={a.id} className="rounded-xl border border-line bg-paper p-4">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium">{a.name}</p>
                      <p className="mt-0.5 text-[13px] text-ink-soft">
                        <span className="font-mono">{a.schedule}</span> ({a.timezone}), {AGENT_LABELS[a.agent.kind]} on {repoName(a.repo.url)}
                      </p>
                      <p className={cx("mt-1 text-[13px]", a.enabled ? "text-ink" : "text-ink-faint")}>
                        {a.enabled ? `Next run ${when(a.nextRunAt, a.timezone)}` : "Paused"}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(a)} aria-label={a.enabled ? `Pause ${a.name}` : `Resume ${a.name}`}>
                      {a.enabled ? <Pause aria-hidden="true" className="size-3.5" /> : <Play aria-hidden="true" className="size-3.5" />}
                      {a.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(a)} aria-label={`Delete ${a.name}`}>
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </Button>
                  </div>
                  {a.recentRuns && a.recentRuns.length > 0 && (
                    <ul aria-label="Recent runs" className="mt-3 flex flex-col gap-1 border-t border-line pt-2 text-[13px]">
                      {a.recentRuns.map(r => (
                        <li key={r.id} className="flex items-center gap-2">
                          <span className={r.status === "started" ? "text-leaf" : r.status === "skipped" ? "text-amber" : "text-danger"}>
                            {r.status === "started" ? "Started" : r.status === "skipped" ? "Skipped" : "Failed"}
                          </span>
                          <span className="text-ink-faint">{new Date(r.ranAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                          <span className="min-w-0 flex-1 truncate text-ink-soft" title={r.detail ?? undefined}>
                            {r.detail}
                          </span>
                          {r.threadId && (
                            <button type="button" className="text-leaf hover:underline" onClick={() => onOpenThread(r.threadId!)}>
                              Open thread
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )
        )}

        <form onSubmit={e => void create(e)} className="mt-8 flex flex-col gap-4 rounded-2xl border border-line bg-paper p-5">
          <h2 className="font-sans text-[16px] font-semibold tracking-normal">New automation</h2>
          <label className="block">
            <span className="mb-1 block text-[13.5px] font-medium">Name</span>
            <TextInput required maxLength={120} value={form.name} onChange={e => set({ name: e.target.value })} placeholder="Nightly dependency bump" />
          </label>
          <div>
            <span className="mb-1 block text-[13.5px] font-medium">When</span>
            <SegmentedControl
              label="Common schedules"
              value={PRESETS.find(p => p.cron === form.schedule)?.cron ?? "custom"}
              onChange={v => v !== "custom" && set({ schedule: v })}
              options={[...PRESETS.map(p => ({ value: p.cron, label: p.label })), { value: "custom", label: "Custom" }]}
            />
            <TextInput
              aria-label="Schedule (cron)"
              className="mt-2 font-mono text-[13px]"
              value={form.schedule}
              onChange={e => set({ schedule: e.target.value })}
              aria-invalid={preview.ok ? undefined : true}
            />
            <p className={cx("mt-1 text-[12.5px]", preview.ok ? "text-ink-faint" : "text-danger")}>
              {preview.text} {preview.ok && `(${zone})`}
            </p>
          </div>
          <div>
            <span className="mb-1 block text-[13.5px] font-medium">Agent</span>
            <SegmentedControl
              label="Agent"
              value={form.agent}
              onChange={v => set({ agent: v })}
              options={(["claude-code", "codex", "opencode"] as const).filter(k => AGENT_CAPABILITIES[k]).map(k => ({ value: k, label: AGENT_LABELS[k] }))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <label className="block">
              <span className="mb-1 block text-[13.5px] font-medium">Repository</span>
              <TextInput
                required
                className="font-mono text-[13px]"
                placeholder="https://github.com/acme/app"
                value={form.repoUrl}
                onChange={e => set({ repoUrl: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13.5px] font-medium">Branch</span>
              <TextInput required className="font-mono text-[13px]" value={form.baseBranch} onChange={e => set({ baseBranch: e.target.value })} />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[13.5px] font-medium">What the agent should do</span>
            <textarea
              required
              rows={4}
              maxLength={50_000}
              value={form.prompt}
              onChange={e => set({ prompt: e.target.value })}
              placeholder="Update the dependencies, run the tests, and open a pull request if anything changed."
              className="w-full rounded-lg border border-control bg-paper px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-leaf"
            />
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={busy || !preview.ok}>
              {busy ? "Saving…" : "Create automation"}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
