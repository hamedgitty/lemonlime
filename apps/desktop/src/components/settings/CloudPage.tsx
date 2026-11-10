import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsTab } from "../../lib/settingsNav.ts";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { CloudError, DEFAULT_WORKSPACE_SETTINGS, planSkillSync, skillsUnsynced, type WorkspaceCloudSettings } from "../../lib/cloud.ts";
import { listOf } from "../../lib/format.ts";
import { confirmAction, listSkills, type SkillInfo } from "../../lib/native.ts";
import { exportSkills } from "../../lib/system.ts";
import { Button, IconButton, RetryCard, Spinner, TextInput, openExternal } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { ErrorText, Pill, Row, SavedNote, Section, Select, Tabs, ToggleRow, useSaved } from "./parts.tsx";

type Tab = "environment" | "keys" | "skills" | "cleanup";

export function CloudPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useSettingsTab<Tab>("cloud", "environment", ["environment", "keys", "skills", "cleanup"]);
  const [ws, setWs] = useState<WorkspaceCloudSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading the settings failed. Nothing is shown as the workspace's until it works.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // An older server without these settings: the defaults are shown and can't be changed.
  const [unsupported, setUnsupported] = useState(false);
  const [saved, markSaved] = useSaved();
  const api = ctx.cloudApi;
  // Only the newest read counts, so a slow answer never replaces a later one.
  const reads = useRef(0);

  const load = useCallback(
    (keepError = false) => {
      if (!api) return;
      const read = ++reads.current;
      if (!keepError) setError(null);
      setLoadError(null);
      setLoading(true);
      api.workspaceSettings().then(
        next => {
          if (read !== reads.current) return;
          setLoading(false);
          setUnsupported(false);
          setWs(next);
        },
        err => {
          if (read !== reads.current) return;
          setLoading(false);
          if (err instanceof CloudError && err.status === 404) {
            setUnsupported(true);
            setWs({ ...DEFAULT_WORKSPACE_SETTINGS, canEdit: false });
          } else setLoadError(err instanceof Error ? err.message : String(err));
        },
      );
    },
    [api],
  );
  useEffect(() => {
    // Another workspace: never show the last one's settings as this one's.
    setWs(null);
    setUnsupported(false);
    load();
  }, [load]);

  if (!api) {
    return (
      <Section title="Cloud" description="Run agents in cloud sandboxes that keep working when your laptop is closed.">
        <Row label="Not connected" description="Connect a LemonLime account to set up the cloud environment.">
          <Button variant="primary" onClick={() => ctx.onPage("account")}>
            Connect
          </Button>
        </Row>
      </Section>
    );
  }

  const save = async (patch: Partial<Omit<WorkspaceCloudSettings, "skills" | "canEdit">>) => {
    if (!ws || ws.canEdit === false) return;
    const before = ws;
    setError(null);
    setWs({ ...ws, ...patch });
    try {
      setWs(await api.saveWorkspaceSettings(patch));
      markSaved();
    } catch (err) {
      // Back to what was saved before, and the reason stays on screen while it is read again.
      setWs(before);
      setError(`That wasn't saved. ${err instanceof Error ? err.message : String(err)}`);
      load(true);
    }
  };
  const canEdit = ws?.canEdit !== false;
  const shownError = error ?? (ws ? loadError : null);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Pill tone="good">Synced with the dashboard</Pill>
        <span className="text-[14px] text-ink-soft">These settings belong to the workspace, so teammates share them.</span>
        <span className="flex-1" />
        <SavedNote show={saved} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "environment", label: "Environment" },
          { id: "keys", label: "API keys" },
          { id: "skills", label: "Skills", ...(ws ? { count: ws.skills.length } : {}) },
          { id: "cleanup", label: "Clean up" },
        ]}
      />
      {shownError && (
        <div className="mb-4">
          <ErrorText>{shownError}</ErrorText>
        </div>
      )}
      {unsupported && (
        <p className="mb-4 rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">
          This server doesn't support cloud environment settings yet. Update it to change these.
        </p>
      )}
      {!canEdit && !unsupported && (
        <p className="mb-4 rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">
          Only the workspace's owner can change these. You can see what new sandboxes start with.
        </p>
      )}
      {!ws ? (
        loadError ? (
          <RetryCard title="Couldn't load the workspace's cloud settings" detail={loadError} onRetry={() => load()} busy={loading} />
        ) : (
          <p className="text-[14px] text-ink-soft">Loading…</p>
        )
      ) : (
        <>
          {tab === "environment" && <EnvironmentTab ws={ws} canEdit={canEdit} onSave={save} />}
          {/* An older server may still keep secrets, so that tab stays usable there. */}
          {tab === "keys" && <KeysTab ctx={ctx} canEdit={canEdit || unsupported} />}
          {tab === "skills" && <SkillsTab ctx={ctx} ws={ws} canEdit={canEdit} onSynced={() => load()} />}
          {tab === "cleanup" && <CleanupTab ws={ws} canEdit={canEdit} onSave={save} dashboard={ctx.settings.controlPlaneUrl} />}
        </>
      )}
    </>
  );
}

function EnvironmentTab({
  ws,
  canEdit,
  onSave,
}: {
  ws: WorkspaceCloudSettings;
  canEdit: boolean;
  onSave: (p: Partial<WorkspaceCloudSettings>) => Promise<void>;
}) {
  const [instructions, setInstructions] = useState(ws.instructions);
  const [script, setScript] = useState(ws.setupScript);
  const area =
    "w-full resize-y rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-faint read-only:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf";
  return (
    <>
      <Section title="Setup script" description="Runs once in every new cloud sandbox, before the agent starts. Its output goes to the thread's log.">
        <textarea
          aria-label="Setup script"
          value={script}
          onChange={e => setScript(e.target.value)}
          onBlur={() => script !== ws.setupScript && void onSave({ setupScript: script })}
          readOnly={!canEdit}
          rows={8}
          maxLength={16_000}
          spellCheck={false}
          placeholder={"# For example\nnpm install -g pnpm\npnpm install"}
          className={`${area} font-mono text-[13px]`}
        />
        <div className="flex flex-wrap gap-2">
          {[
            ["pnpm", "npm install -g pnpm"],
            ["Bun", "curl -fsSL https://bun.sh/install | bash"],
            ["uv (Python)", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
            ["GitHub CLI", "(type gh || (sudo apt-get update && sudo apt-get install -y gh))"],
          ].map(([label, line]) => (
            <Button
              key={label}
              size="sm"
              variant="ghost"
              disabled={!canEdit || script.includes(line!)}
              onClick={() => {
                const next = `${script.trimEnd()}${script.trim() ? "\n" : ""}${line}\n`;
                setScript(next);
                void onSave({ setupScript: next });
              }}
            >
              <Plus aria-hidden="true" className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </Section>
      <Section
        title="Instructions for cloud agents"
        description="Told to every cloud agent at the start of each thread, like Custom instructions on this computer."
      >
        <textarea
          aria-label="Instructions for cloud agents"
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          onBlur={() => instructions !== ws.instructions && void onSave({ instructions })}
          readOnly={!canEdit}
          rows={6}
          maxLength={32_000}
          className={area}
        />
      </Section>
      <Section title="Agents in the cloud">
        <ToggleRow
          label="Remove AI co-author lines"
          description="Cloud agents' commits won't carry “Co-authored-by” lines."
          checked={ws.stripCoauthors}
          onChange={stripCoauthors => void onSave({ stripCoauthors })}
          disabled={!canEdit}
        />
        <Row label="When a limit is hit, wait and try again" description="Up to this long; then the thread stops and tells you.">
          <Select
            label="When a limit is hit, wait and try again"
            value={String(ws.retryMaxWaitMinutes)}
            onChange={v => void onSave({ retryMaxWaitMinutes: Number(v) })}
            disabled={!canEdit}
            options={[
              { value: "0", label: "Don't retry" },
              { value: "60", label: "Up to 1 hour" },
              { value: "360", label: "Up to 6 hours" },
              { value: "1440", label: "Up to a day" },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

function KeysTab({ ctx, canEdit }: { ctx: SettingsCtx; canEdit: boolean }) {
  const api = ctx.cloudApi!;
  const [list, setList] = useState<{ name: string; updatedAt: string }[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void api.listSecrets().then(setList, e => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);
  useEffect(load, [load]);
  const add = async () => {
    const n = name.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(n)) return setError("Names are letters, numbers and underscores, like OPENAI_API_KEY.");
    if (!value) return setError("Enter the value.");
    // Saving under a name that's taken throws the old value away, and it can't be read back.
    if (list?.some(s => s.name === n) && !(await confirmAction(`Replace ${n}? Its old value can't be brought back.`))) return;
    setBusy(true);
    setError(null);
    try {
      await api.setSecret(n, value);
      setName("");
      setValue("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n: string) => {
    if (!(await confirmAction(`Delete ${n}? New cloud sandboxes won't get it.`))) return;
    await api.deleteSecret(n).then(load, e => setError(String(e)));
  };
  return (
    <Section
      title="API keys and secrets"
      description="Encrypted as soon as they're saved, and given to every new cloud sandbox as environment variables. Values can't be shown again."
      aside={
        <IconButton label="Refresh" onClick={load}>
          <RefreshCw aria-hidden="true" className="size-4" />
        </IconButton>
      }
    >
      {list === null && !error && <p className="text-[14px] text-ink-soft">Loading…</p>}
      {list?.length === 0 && <p className="text-[14px] text-ink-soft">None yet.</p>}
      {list?.map(s => (
        <Row key={s.name} label={<span className="font-mono text-[14px]">{s.name}</span>} description={`Changed ${new Date(s.updatedAt).toLocaleDateString()}`}>
          <IconButton label={`Delete ${s.name}`} onClick={() => void remove(s.name)} disabled={!canEdit}>
            <Trash2 aria-hidden="true" className="size-4" />
          </IconButton>
        </Row>
      ))}
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <label className="flex flex-col gap-1 text-[13px] text-ink-soft">
          Name
          <TextInput
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="OPENAI_API_KEY"
            className="w-[200px] font-mono text-[13px]"
            spellCheck={false}
            disabled={!canEdit}
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
          Value
          <TextInput
            type="password"
            value={value}
            onChange={e => setValue(e.target.value)}
            autoComplete="off"
            className="font-mono text-[13px]"
            disabled={!canEdit}
          />
        </label>
        <Button onClick={() => void add()} disabled={busy || !canEdit}>
          {busy && <Spinner />}
          Add
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function SkillsTab({ ctx, ws, canEdit, onSynced }: { ctx: SettingsCtx; ws: WorkspaceCloudSettings; canEdit: boolean; onSynced: () => void }) {
  const api = ctx.cloudApi!;
  const [mine, setMine] = useState<SkillInfo[] | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(ws.skills.map(s => s.name)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, markSaved] = useSaved();
  const loadMine = useCallback(() => {
    setMineError(null);
    listSkills().then(
      list => setMine(list.filter(s => s.source === "yours")),
      err => setMineError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  useEffect(loadMine, [loadMine]);

  const here = mine?.map(s => s.name) ?? [];
  const cloud = ws.skills.map(s => s.name);
  // In the cloud but not on this computer: another computer synced them.
  const elsewhere = mine ? cloud.filter(name => !here.includes(name)) : [];
  const unsynced = mine !== null && skillsUnsynced(picked, here, cloud);

  const sync = async () => {
    if (!mine) return;
    const plan = planSkillSync(picked, here, cloud);
    if (plan.drop.length > 0) {
      const gone =
        plan.drop.length === 1
          ? `Remove ${plan.drop[0]} from the cloud? It isn't on this computer, so it can't be put back from here.`
          : `Remove ${listOf(plan.drop)} from the cloud? They aren't on this computer, so they can't be put back from here.`;
      if (!(await confirmAction(gone))) return;
    }
    setBusy(true);
    setError(null);
    try {
      // Syncing replaces the whole list. Skills from another computer go back as the cloud has them.
      const kept = plan.keep.length > 0 ? (await api.workspaceSkills()).filter(s => plan.keep.includes(s.name)) : [];
      const sent = plan.send.length > 0 ? await exportSkills(plan.send) : [];
      await api.saveWorkspaceSkills([...sent, ...kept]);
      markSaved();
      onSynced();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name: string, on: boolean) =>
    setPicked(p => {
      const next = new Set(p);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  return (
    <Section
      title="Skills for cloud agents"
      description="Your skills reach every thread on this computer. Pick which ones cloud sandboxes get too; they're uploaded to the workspace."
      aside={<SavedNote show={saved} text="Synced" />}
    >
      {mine === null && !mineError && <p className="text-[14px] text-ink-soft">Loading…</p>}
      {mineError && (
        <div className="flex flex-wrap items-center gap-3">
          <ErrorText>Couldn't read this computer's skills. {mineError}</ErrorText>
          <Button size="sm" onClick={loadMine}>
            Try again
          </Button>
        </div>
      )}
      {mine?.length === 0 && <p className="text-[14px] text-ink-soft">You have no skills of your own yet. Add some on the Skills page.</p>}
      {mine?.map(s => (
        <ToggleRow
          key={s.name}
          label={s.name}
          description={s.description || undefined}
          checked={picked.has(s.name)}
          onChange={v => toggle(s.name, v)}
          disabled={!canEdit}
        />
      ))}
      {elsewhere.map(name => (
        <ToggleRow
          key={name}
          label={name}
          description="Added from another computer. It isn't on this one."
          checked={picked.has(name)}
          onChange={v => toggle(name, v)}
          disabled={!canEdit}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button variant="primary" onClick={() => void sync()} disabled={busy || mine === null || !canEdit}>
          {busy && <Spinner />}
          Sync to the cloud
        </Button>
        <Button variant="ghost" onClick={() => setPicked(new Set([...here, ...elsewhere]))} disabled={mine === null || !canEdit}>
          Select all
        </Button>
        <Button variant="ghost" onClick={() => setPicked(new Set())} disabled={mine === null || !canEdit}>
          Clear
        </Button>
        {unsynced && canEdit && !busy && (
          <span role="status" className="text-[14px] text-ink-soft">
            Not in the cloud yet. Sync to send your changes.
          </span>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function CleanupTab({
  ws,
  canEdit,
  onSave,
  dashboard,
}: {
  ws: WorkspaceCloudSettings;
  canEdit: boolean;
  onSave: (p: Partial<WorkspaceCloudSettings>) => Promise<void>;
  dashboard: string;
}) {
  const pick = async (v: string) => {
    const days = v === "never" ? null : Number(v);
    // Turning this on, or making it sooner, deletes sandboxes: ask first.
    const sooner = days !== null && (ws.autoDeleteDays === null || days < ws.autoDeleteDays);
    if (
      sooner &&
      !(await confirmAction(
        `Delete cloud threads left unused for ${days} days? Their sandboxes are deleted and can't be brought back. Their branches stay on GitHub.`,
      ))
    )
      return;
    await onSave({ autoDeleteDays: days });
  };
  return (
    <Section title="Clean up" description="Old cloud threads keep their sandbox's disk. Clearing them out keeps the workspace tidy.">
      <Row
        label="Delete unused cloud threads after"
        description="Threads with no activity for this long are archived and their sandbox deleted. Their branches stay on GitHub."
      >
        <Select
          label="Delete unused cloud threads after"
          value={ws.autoDeleteDays === null ? "never" : String(ws.autoDeleteDays)}
          onChange={v => void pick(v)}
          disabled={!canEdit}
          options={[
            { value: "never", label: "Never" },
            { value: "3", label: "3 days" },
            { value: "7", label: "7 days" },
            { value: "14", label: "14 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
      </Row>
      <Row label="Everything else" description="Members, GitHub and personal access tokens are in the dashboard.">
        <Button onClick={() => void openExternal(`${dashboard}/settings`)}>Open dashboard</Button>
      </Row>
    </Section>
  );
}
