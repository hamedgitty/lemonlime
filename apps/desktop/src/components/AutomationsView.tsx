import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AlarmClock, Check, CheckCheck, CircleDashed, Pause, Pencil, Play, Plus, RotateCw, SkipForward, Trash2, Webhook, X } from "lucide-react";
import { nextRun, parseSchedule, WEBHOOK_BODY_MAX_BYTES, type AgentKind } from "@lemonlime/protocol";
import type { AutomationInfo, AutomationRun, CloudApi } from "../lib/cloud.ts";
import { AGENT_LABELS, relativeTime, repoName } from "../lib/format.ts";
import { CopyButton } from "../lib/markdown.tsx";
import { confirmAction } from "../lib/native.ts";
import { PageTabs } from "./primitives.tsx";
import { Button, SegmentedControl, SkeletonRows, TextInput, cx } from "./ui.tsx";

const PRESETS = [
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Nightly 3:00", cron: "0 3 * * *" },
  { label: "Mondays 8:00", cron: "0 8 * * 1" },
  { label: "Hourly", cron: "0 * * * *" },
];

/** Ready-made automations. Picking one fills the form; nothing runs until it's saved. */
export const TEMPLATES: { group: string; name: string; schedule: string; prompt: string }[] = [
  {
    group: "Security",
    name: "Dependency vulnerabilities",
    schedule: "0 6 * * 1",
    prompt:
      "Check this repository's dependencies for known vulnerabilities with the package manager's audit command. Upgrade what can be upgraded safely, run the tests, and open a pull request listing each advisory and what changed. If nothing needs doing, say so and stop.",
  },
  {
    group: "Security",
    name: "Secrets check",
    schedule: "0 7 * * 1",
    prompt:
      "Look through the repository and its recent commits for secrets that shouldn't be there: API keys, tokens, passwords, private keys. Report each with the file and line, and how to rotate it. Don't print the secret itself.",
  },
  {
    group: "Security",
    name: "Risky code review",
    schedule: "0 8 * * 3",
    prompt:
      "Review the code changed in the last week for security problems: injection, missing authorization checks, unsafe file or shell access, unvalidated input. Fix clear problems with tests in a pull request; list anything you weren't sure about.",
  },
  {
    group: "Code health",
    name: "Nightly dependency bump",
    schedule: "0 3 * * *",
    prompt:
      "Update the dependencies to their latest compatible versions, run the build and tests, and open a pull request if anything changed and everything passes.",
  },
  {
    group: "Code health",
    name: "Flaky and failing tests",
    schedule: "0 5 * * 1-5",
    prompt:
      "Run the test suite three times. Find tests that fail or pass only sometimes, work out why, and fix them in a pull request. Explain each cause in the description.",
  },
  {
    group: "Code health",
    name: "Dead code sweep",
    schedule: "0 4 * * 6",
    prompt:
      "Find code that's no longer used: unexported functions nothing calls, unused files, stale feature flags. Remove what's clearly dead in a pull request, with tests passing, and list anything you left because you weren't sure.",
  },
  {
    group: "Code health",
    name: "Type and lint clean-up",
    schedule: "0 4 * * 0",
    prompt: "Run the type checker and linter. Fix the warnings and errors that have a clear fix, without changing behaviour, and open a pull request.",
  },
  {
    group: "Reviews",
    name: "Weekly change summary",
    schedule: "0 9 * * 5",
    prompt:
      "Summarise what changed in this repository this week, in plain English for the team: what shipped, what's in progress, and anything risky. Group it by area. Don't change any code.",
  },
  {
    group: "Reviews",
    name: "Open pull request check",
    schedule: "0 10 * * 1-5",
    prompt:
      "Look at the open pull requests. For each, say whether it's ready, what's blocking it, and whether it conflicts with the main branch. Keep it to a short list, most urgent first.",
  },
  {
    group: "Reviews",
    name: "TODO tracker",
    schedule: "0 9 1 * *",
    prompt:
      "Collect every TODO, FIXME and HACK comment in the code, with file and line, oldest first by git blame. Suggest which three to tackle first and why.",
  },
  {
    group: "Ops",
    name: "Error log triage",
    schedule: "0 8 * * 1-5",
    prompt:
      "Read the error logs the repository has access to (see the README for where they are). Group the errors by cause, rank them by how often they happen, and fix the top one with a test if the fix is clear.",
  },
  {
    group: "Ops",
    name: "Broken links",
    schedule: "0 6 * * 0",
    prompt: "Check every link in the docs and README. Fix broken internal links, and list external links that no longer work with a suggested replacement.",
  },
  {
    group: "Docs",
    name: "Docs that drifted",
    schedule: "0 7 * * 4",
    prompt:
      "Compare the docs with the code: commands, options, environment variables and examples. Fix anything out of date in a pull request, and keep the writing plain and short.",
  },
  {
    group: "Docs",
    name: "Changelog draft",
    schedule: "0 16 * * 5",
    prompt:
      "Draft this week's changelog entry from the merged pull requests, grouped into new, improved and fixed, written for users. Open it as a pull request.",
  },
];

const when = (iso: string | null, tz: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz })
    : "Not scheduled";

type Tab = "overview" | "review" | "templates" | "scans";
type Form = {
  name: string;
  schedule: string;
  agent: AgentKind;
  repoUrl: string;
  baseBranch: string;
  prompt: string;
  checkScript: string;
  size: "small" | "large";
};
const EMPTY: Form = { name: "", schedule: PRESETS[0]!.cron, agent: "claude-code", repoUrl: "", baseBranch: "main", prompt: "", checkScript: "", size: "small" };

/**
 * Automations: a prompt that starts a new cloud thread on a schedule or when its webhook
 * is called. They run in the cloud whether or not this app is open; a run the plan can't
 * cover, or whose check script finds nothing to do, is skipped.
 */
export function AutomationsView({
  cloudApi,
  onConnectCloud,
  onOpenThread,
  scans,
}: {
  cloudApi: CloudApi | null;
  onConnectCloud: () => void;
  onOpenThread: (id: string) => void;
  /** How you work with agents on this computer, when this build can read their history. */
  scans?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [list, setList] = useState<AutomationInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);

  const load = useCallback(() => {
    if (!cloudApi) return;
    cloudApi.listAutomations().then(setList, e => setError(e instanceof Error ? e.message : String(e)));
  }, [cloudApi]);
  useEffect(load, [load]);

  const toReview = useMemo(() => (list ?? []).flatMap(a => (a.recentRuns ?? []).filter(r => r.status !== "skipped" && !r.reviewedAt)).length, [list]);

  if (!cloudApi && (tab === "overview" || tab === "review")) {
    return (
      <main className="flex flex-1 flex-col">
        <Header tab={tab} onTab={setTab} toReview={0} hasScans={Boolean(scans)} onNew={null} />
        <div className="flex flex-1 items-center justify-center p-10">
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
        </div>
      </main>
    );
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <Header tab={tab} onTab={setTab} toReview={toReview} hasScans={Boolean(scans)} onNew={cloudApi ? () => setEditing({ id: null, form: EMPTY }) : null} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[800px] px-6 pt-6 pb-16">
          {error && (
            <p role="alert" className="mb-4 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[14px]">
              {error}
            </p>
          )}
          {editing && cloudApi && (
            <Editor
              key={editing.id ?? "new"}
              initial={editing.form}
              isNew={!editing.id}
              onCancel={() => setEditing(null)}
              onSave={async f => {
                const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
                const body = {
                  name: f.name.trim(),
                  schedule: f.schedule.trim(),
                  timezone: zone,
                  agent: { kind: f.agent },
                  repo: { url: f.repoUrl.trim(), baseBranch: f.baseBranch.trim() || "main" },
                  sandboxSize: f.size,
                  prompt: f.prompt.trim(),
                  checkScript: f.checkScript.trim(),
                };
                if (editing.id) {
                  const u = await cloudApi.updateAutomation(editing.id, body);
                  setList(l => l?.map(x => (x.id === editing.id ? { ...x, ...u } : x)) ?? null);
                } else {
                  const a = await cloudApi.createAutomation(body);
                  setList(l => [...(l ?? []), { ...a, recentRuns: [] }]);
                }
                setEditing(null);
                setTab("overview");
              }}
            />
          )}
          {tab === "overview" && cloudApi && (
            <Overview
              list={list}
              onEdit={a =>
                setEditing({
                  id: a.id,
                  form: {
                    name: a.name,
                    schedule: a.schedule,
                    agent: a.agent.kind,
                    repoUrl: a.repo.url,
                    baseBranch: a.repo.baseBranch,
                    prompt: a.prompt,
                    checkScript: a.checkScript ?? "",
                    size: a.sandboxSize ?? "small",
                  },
                })
              }
              onToggle={a =>
                act(async () => {
                  const u = await cloudApi.updateAutomation(a.id, { enabled: !a.enabled });
                  setList(l => l?.map(x => (x.id === a.id ? { ...x, ...u } : x)) ?? null);
                })
              }
              onRemove={a =>
                act(async () => {
                  if (!(await confirmAction(`Delete "${a.name}"? Threads it already started stay.`))) return;
                  await cloudApi.deleteAutomation(a.id);
                  setList(l => l?.filter(x => x.id !== a.id) ?? null);
                })
              }
              onOpenThread={onOpenThread}
              onTemplates={() => setTab("templates")}
              cloudApi={cloudApi}
              onChanged={(id, patch) => setList(l => l?.map(x => (x.id === id ? { ...x, ...patch } : x)) ?? null)}
            />
          )}
          {tab === "review" && cloudApi && (
            <Review
              list={list}
              onOpenThread={onOpenThread}
              onReview={(a, runId, reviewed) =>
                act(async () => {
                  await cloudApi.reviewRun(a.id, runId, reviewed);
                  load();
                })
              }
              onReviewAll={() =>
                act(async () => {
                  await cloudApi.reviewAllRuns();
                  load();
                })
              }
            />
          )}
          {tab === "templates" && (
            <Templates
              onUse={t => {
                setEditing({ id: null, form: { ...EMPTY, name: t.name, schedule: t.schedule, prompt: t.prompt } });
                setTab("overview");
              }}
              disabled={!cloudApi}
            />
          )}
          {tab === "scans" && scans}
        </div>
      </div>
    </main>
  );
}

function Header({
  tab,
  onTab,
  toReview,
  hasScans,
  onNew,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  toReview: number;
  hasScans: boolean;
  onNew: (() => void) | null;
}) {
  return (
    <header className="shrink-0 border-b border-line px-6">
      <div data-tauri-drag-region className="flex h-[52px] items-center gap-3">
        <h1 className="flex items-center gap-2 font-sans text-[15px] font-semibold tracking-normal">
          <AlarmClock aria-hidden="true" className="size-4 text-ink-soft" />
          Automations
        </h1>
        <span className="flex-1" />
        {onNew && (
          <Button size="sm" variant="primary" onClick={onNew}>
            <Plus aria-hidden="true" className="size-4" />
            New
          </Button>
        )}
      </div>
      <PageTabs
        label="Automations"
        value={tab}
        onChange={onTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "review", label: "Review", ...(toReview ? { count: toReview, attention: true } : {}) },
          { id: "templates", label: "Templates", count: TEMPLATES.length },
          ...(hasScans ? [{ id: "scans" as const, label: "Scans" }] : []),
        ]}
      />
    </header>
  );
}

function Overview({
  list,
  onEdit,
  onToggle,
  onRemove,
  onOpenThread,
  onTemplates,
  cloudApi,
  onChanged,
}: {
  list: AutomationInfo[] | null;
  onEdit: (a: AutomationInfo) => void;
  onToggle: (a: AutomationInfo) => void;
  onRemove: (a: AutomationInfo) => void;
  onOpenThread: (id: string) => void;
  onTemplates: () => void;
  cloudApi: CloudApi;
  onChanged: (id: string, patch: Partial<AutomationInfo>) => void;
}) {
  if (list === null) return <SkeletonRows rows={4} label="Loading automations" />;
  if (list.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
        <p className="text-[15px] font-medium">No automations yet</p>
        <p className="mt-1 text-[14px] text-ink-soft">
          A prompt that starts a cloud thread on a schedule, like a nightly dependency bump, or when a webhook is called. Start from a template, or write your
          own.
        </p>
        <Button className="mt-4" onClick={onTemplates}>
          Browse templates
        </Button>
      </div>
    );
  const active = list.filter(a => a.enabled);
  const paused = list.filter(a => !a.enabled);
  const card = (a: AutomationInfo) => (
    <AutomationCard
      key={a.id}
      a={a}
      onEdit={onEdit}
      onToggle={onToggle}
      onRemove={onRemove}
      onOpenThread={onOpenThread}
      cloudApi={cloudApi}
      onChanged={patch => onChanged(a.id, patch)}
    />
  );
  return (
    <>
      {active.length > 0 && <ul className="flex flex-col gap-3">{active.map(card)}</ul>}
      {paused.length > 0 && (
        <section className={cx(active.length > 0 && "mt-8")} aria-labelledby="paused-automations">
          <h2 id="paused-automations" className="mb-2.5 flex items-center gap-2 font-sans text-[14px] font-semibold tracking-normal">
            Paused
            <span className="rounded-full bg-cream-deep px-1.5 text-[12px] font-normal text-ink-soft tabular-nums">{paused.length}</span>
          </h2>
          <ul className="flex flex-col gap-3">{paused.map(card)}</ul>
        </section>
      )}
    </>
  );
}

function scheduleText(a: AutomationInfo): string {
  return a.schedule ? `${a.schedule} (${a.timezone})` : "Webhook only";
}

function AutomationCard({
  a,
  onEdit,
  onToggle,
  onRemove,
  onOpenThread,
  cloudApi,
  onChanged,
}: {
  a: AutomationInfo;
  onEdit: (a: AutomationInfo) => void;
  onToggle: (a: AutomationInfo) => void;
  onRemove: (a: AutomationInfo) => void;
  onOpenThread: (id: string) => void;
  cloudApi: CloudApi;
  onChanged: (patch: Partial<AutomationInfo>) => void;
}) {
  const [hookOpen, setHookOpen] = useState(false);
  const [allRuns, setAllRuns] = useState<AutomationRun[] | "loading" | null>(null);
  const runs = Array.isArray(allRuns) ? allRuns : (a.recentRuns ?? []).slice(0, 5);
  return (
    <li className={cx("rounded-xl border bg-paper p-4", a.enabled ? "border-line" : "border-line-strong")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">{a.name}</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            <span className={cx(a.schedule && "font-mono")}>{scheduleText(a)}</span>, {AGENT_LABELS[a.agent.kind]} on {repoName(a.repo.url)}
            {a.hasWebhook && a.schedule ? ", and by webhook" : ""}
            {a.checkScript ? ", checks first" : ""}
          </p>
          {a.enabled ? (
            a.schedule && <p className="mt-1 text-[13px] text-ink">Next run {when(a.nextRunAt, a.timezone)}</p>
          ) : (
            <p className="mt-1 text-[13px] text-ink">{a.pausedReason ? `Paused automatically. ${a.pausedReason}` : "Paused by you."}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onEdit(a)} aria-label={`Edit ${a.name}`}>
          <Pencil aria-hidden="true" className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setHookOpen(o => !o)}
          aria-expanded={hookOpen}
          aria-label={`Webhook for ${a.name}`}
          className={cx(a.hasWebhook && "text-leaf")}
        >
          <Webhook aria-hidden="true" className="size-3.5" />
        </Button>
        <Button size="sm" variant={a.enabled ? "ghost" : "primary"} onClick={() => onToggle(a)} aria-label={a.enabled ? `Pause ${a.name}` : `Resume ${a.name}`}>
          {a.enabled ? <Pause aria-hidden="true" className="size-3.5" /> : <Play aria-hidden="true" className="size-3.5" />}
          {a.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onRemove(a)} aria-label={`Delete ${a.name}`}>
          <Trash2 aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      {hookOpen && <WebhookPanel a={a} cloudApi={cloudApi} onChanged={onChanged} />}
      {runs.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <ul aria-label={`Runs of ${a.name}`} className="flex flex-col gap-1 text-[13px]">
            {runs.map(r => (
              <RunLine key={r.id} run={r} onOpenThread={onOpenThread} />
            ))}
          </ul>
          {!Array.isArray(allRuns) && (a.recentRuns?.length ?? 0) >= 5 && (
            <button
              type="button"
              disabled={allRuns === "loading"}
              className="mt-1.5 text-[13px] text-leaf hover:underline disabled:opacity-60"
              onClick={() => {
                setAllRuns("loading");
                cloudApi.automationRuns(a.id).then(setAllRuns, () => setAllRuns(null));
              }}
            >
              {allRuns === "loading" ? "Loading…" : "Show all runs"}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** The webhook: a secret URL that starts a run when called. Its secret is only shown once, right after it's made. */
function WebhookPanel({ a, cloudApi, onChanged }: { a: AutomationInfo; cloudApi: CloudApi; onChanged: (patch: Partial<AutomationInfo>) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const make = () =>
    run(async () => {
      setUrl(await cloudApi.rotateAutomationWebhook(a.id));
      onChanged({ hasWebhook: true });
    });
  return (
    <div className="mt-3 rounded-lg border border-line bg-cream px-3.5 py-3">
      <p className="text-[14px] text-ink-soft">
        A POST to this URL starts a run. Any JSON body (up to {WEBHOOK_BODY_MAX_BYTES / 1024} KB) is passed to the agent as context, marked as untrusted input.
      </p>
      {url ? (
        <>
          <div className="mt-2.5 flex items-center gap-2">
            <TextInput readOnly value={url} aria-label="Webhook URL" className="font-mono text-[13px]" onFocus={e => e.currentTarget.select()} />
            <CopyButton text={url} label="Copy webhook URL" showLabel className="h-9 shrink-0 px-2.5" />
          </div>
          <p className="mt-1.5 text-[13px] text-ink-soft">Copy it now: it won't be shown again. Anyone with it can start this automation.</p>
        </>
      ) : a.hasWebhook ? (
        <p className="mt-2 text-[14px]">The webhook is on. Its URL was shown when it was made; make a new one if you've lost it.</p>
      ) : null}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-2.5 flex gap-2">
        {a.hasWebhook ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (await confirmAction("Make a new webhook URL? The old one stops working straight away.")) await make();
                })()
              }
            >
              <RotateCw aria-hidden="true" className="size-3.5" />
              New URL
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await cloudApi.removeAutomationWebhook(a.id);
                  setUrl(null);
                  onChanged({ hasWebhook: false });
                })
              }
            >
              Turn off
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void make()}>
            {busy ? "Making…" : "Make a webhook URL"}
          </Button>
        )}
      </div>
    </div>
  );
}

const OUTCOME: Record<NonNullable<AutomationRun["outcome"]>, { label: string; className: string; icon: ReactNode }> = {
  started: { label: "Started", className: "text-ink-soft", icon: <CircleDashed aria-hidden="true" className="size-3.5" /> },
  finished: { label: "Finished", className: "text-leaf", icon: <Check aria-hidden="true" className="size-3.5" /> },
  skipped: { label: "Skipped", className: "text-amber", icon: <SkipForward aria-hidden="true" className="size-3.5" /> },
  failed: { label: "Failed", className: "text-danger", icon: <X aria-hidden="true" className="size-3.5" /> },
};

function RunLine({ run: r, onOpenThread }: { run: AutomationRun; onOpenThread: (id: string) => void }) {
  const o = OUTCOME[r.outcome ?? r.status];
  return (
    <li className="flex items-center gap-2">
      <span className={cx("inline-flex w-[5.5rem] shrink-0 items-center gap-1", o.className)}>
        {o.icon}
        {o.label}
      </span>
      <span className="shrink-0 text-ink-faint tabular-nums">
        {new Date(r.ranAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        {r.trigger === "webhook" ? ", webhook" : ""}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-soft" title={r.summary ?? r.detail ?? undefined}>
        {r.summary ?? r.detail}
      </span>
      {r.threadId && r.status !== "skipped" && (
        <button type="button" className="shrink-0 text-leaf hover:underline" onClick={() => onOpenThread(r.threadId!)}>
          Open thread
        </button>
      )}
    </li>
  );
}

function Review({
  list,
  onOpenThread,
  onReview,
  onReviewAll,
}: {
  list: AutomationInfo[] | null;
  onOpenThread: (id: string) => void;
  onReview: (a: AutomationInfo, runId: string, reviewed: boolean) => void;
  onReviewAll: () => void;
}) {
  const [show, setShow] = useState<"todo" | "all">("todo");
  const runs = (list ?? [])
    .flatMap(a => (a.recentRuns ?? []).map(r => ({ a, r })))
    .filter(({ r }) => r.status !== "skipped" && (show === "all" || !r.reviewedAt))
    .sort((x, y) => y.r.ranAt.localeCompare(x.r.ranAt));
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <SegmentedControl
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: "todo", label: "To review" },
            { value: "all", label: "All" },
          ]}
        />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!runs.some(x => !x.r.reviewedAt)} onClick={onReviewAll}>
          <CheckCheck aria-hidden="true" className="size-4" />
          Mark all reviewed
        </Button>
      </div>
      {list === null && <SkeletonRows rows={4} label="Loading runs" />}
      {list !== null && runs.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
          <p className="text-[15px] font-medium">{show === "todo" ? "All caught up" : "Nothing yet"}</p>
          <p className="mt-1 text-[14px] text-ink-soft">Each time an automation runs, its result lands here for you to look over.</p>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {runs.map(({ a, r }) => (
          <li
            key={r.id}
            className={cx("flex items-start gap-3 rounded-xl border bg-paper p-3.5", r.reviewedAt ? "border-line opacity-75" : "border-line-strong")}
          >
            <span
              aria-hidden="true"
              className={cx(
                "mt-1.5 size-2 shrink-0 rounded-full",
                r.reviewedAt ? "bg-control" : (r.outcome ?? r.status) === "failed" ? "bg-danger" : "bg-lime-2",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium">{a.name}</p>
              <p className="text-[13px] text-ink-soft">
                {(r.outcome ?? r.status) === "failed" ? "Failed" : "Ran"} {relativeTime(r.ranAt)} on {repoName(a.repo.url)}
              </p>
              {(r.summary || r.detail) && <p className="mt-1 line-clamp-3 text-[14px]">{r.summary ?? r.detail}</p>}
            </div>
            {r.threadId && (
              <Button size="sm" variant="ghost" onClick={() => onOpenThread(r.threadId!)}>
                Open
              </Button>
            )}
            <Button size="sm" onClick={() => onReview(a, r.id, !r.reviewedAt)}>
              {r.reviewedAt ? "Mark unread" : "Reviewed"}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Templates({ onUse, disabled }: { onUse: (t: (typeof TEMPLATES)[number]) => void; disabled: boolean }) {
  const groups = [...new Set(TEMPLATES.map(t => t.group))];
  return (
    <>
      {groups.map(g => (
        <section key={g} className="mb-7">
          <h2 className="mb-2.5 flex items-center gap-2 font-sans text-[14px] font-semibold tracking-normal">
            {g}
            <span className="rounded-full bg-cream-deep px-1.5 text-[12px] font-normal text-ink-soft">{TEMPLATES.filter(t => t.group === g).length}</span>
          </h2>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {TEMPLATES.filter(t => t.group === g).map(t => (
              <li key={t.name} className="flex flex-col rounded-xl border border-line bg-paper p-4">
                <p className="text-[15px] font-medium">{t.name}</p>
                <p className="mt-1 line-clamp-3 flex-1 text-[13px] text-ink-soft">{t.prompt}</p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="flex-1 text-[13px] text-ink-faint">{describeCron(t.schedule)}</span>
                  <Button size="sm" disabled={disabled} onClick={() => onUse(t)}>
                    Use
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** A plain reading of the simple schedules the templates use. */
export function describeCron(cron: string): string {
  const [min, hour, dom, , dow] = cron.split(" ");
  const time = `${hour!.padStart(2, "0")}:${min!.padStart(2, "0")}`;
  if (dom !== "*" && dow === "*") return `Monthly on day ${dom}, ${time}`;
  if (dow === "*") return `Daily at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (/^\d$/.test(dow!)) return `${DAYS[Number(dow)]} at ${time}`;
  return cron;
}

function Editor({ initial, isNew, onCancel, onSave }: { initial: Form; isNew: boolean; onCancel: () => void; onSave: (f: Form) => Promise<void> }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const set = (p: Partial<Form>) => setForm(f => ({ ...f, ...p }));
  const preview = useMemo(() => {
    if (!form.schedule.trim()) return { ok: true, text: "Runs only when its webhook is called. Make the webhook URL after saving." };
    try {
      parseSchedule(form.schedule);
      const next = nextRun(form.schedule, new Date(), zone);
      return { ok: true, text: next ? `Next: ${when(next.toISOString(), zone)}` : "That schedule never comes round." };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }, [form.schedule, zone]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={e => void submit(e)} className="mb-8 flex flex-col gap-4 rounded-2xl border border-line-strong bg-paper p-5 shadow-panel">
      <h2 className="font-sans text-[16px] font-semibold tracking-normal">{isNew ? "New automation" : `Edit ${initial.name}`}</h2>
      <label className="block">
        <span className="mb-1 block text-[14px] font-medium">Name</span>
        <TextInput required maxLength={120} value={form.name} onChange={e => set({ name: e.target.value })} placeholder="Nightly dependency bump" />
      </label>
      <div>
        <span className="mb-1 block text-[14px] font-medium">When</span>
        <SegmentedControl
          label="Common schedules"
          value={form.schedule.trim() === "" ? "webhook" : (PRESETS.find(p => p.cron === form.schedule)?.cron ?? "custom")}
          onChange={v => set({ schedule: v === "webhook" ? "" : v === "custom" ? form.schedule || "0 9 * * *" : v })}
          options={[
            ...PRESETS.map(p => ({ value: p.cron, label: p.label })),
            { value: "custom", label: "Custom" },
            { value: "webhook", label: "Webhook", hint: "No schedule: it runs only when its webhook is called" },
          ]}
        />
        {form.schedule.trim() !== "" ? (
          <TextInput
            aria-label="Schedule (cron)"
            className="mt-2 font-mono text-[13px]"
            value={form.schedule}
            onChange={e => set({ schedule: e.target.value })}
            aria-invalid={preview.ok ? undefined : true}
          />
        ) : null}
        <p className={cx("mt-1 text-[13px]", preview.ok ? "text-ink-faint" : "text-danger")}>
          {preview.text} {preview.ok && form.schedule.trim() && `(${zone})`}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-[14px] font-medium">Agent</span>
          <SegmentedControl
            label="Agent"
            value={form.agent}
            onChange={v => set({ agent: v })}
            options={(["claude-code", "codex", "opencode"] as const).map(k => ({ value: k, label: AGENT_LABELS[k] }))}
          />
        </div>
        <div>
          <span className="mb-1 block text-[14px] font-medium">Sandbox</span>
          <SegmentedControl
            label="Sandbox size"
            value={form.size}
            onChange={v => set({ size: v })}
            options={[
              { value: "small", label: "Small" },
              { value: "large", label: "Large" },
            ]}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <label className="block">
          <span className="mb-1 block text-[14px] font-medium">Repository</span>
          <TextInput
            required
            className="font-mono text-[13px]"
            placeholder="https://github.com/acme/app"
            value={form.repoUrl}
            onChange={e => set({ repoUrl: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[14px] font-medium">Branch</span>
          <TextInput required className="font-mono text-[13px]" value={form.baseBranch} onChange={e => set({ baseBranch: e.target.value })} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[14px] font-medium">What the agent should do</span>
        <textarea
          required
          rows={5}
          maxLength={50_000}
          value={form.prompt}
          onChange={e => set({ prompt: e.target.value })}
          placeholder="Update the dependencies, run the tests, and open a pull request if anything changed."
          className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint focus:border-leaf"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[14px] font-medium">Check first (optional)</span>
        <textarea
          rows={2}
          maxLength={10_000}
          value={form.checkScript}
          onChange={e => set({ checkScript: e.target.value })}
          spellCheck={false}
          placeholder="git log --since=yesterday --oneline"
          className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-leaf"
        />
        <span className="mt-1 block text-[13px] text-ink-faint">
          A shell command run in the sandbox before the agent starts. If it prints nothing or fails, the run is skipped; what it prints is given to the agent.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-[14px] text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !preview.ok}>
          {busy ? "Saving…" : isNew ? "Create automation" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
