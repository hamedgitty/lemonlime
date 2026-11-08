import { useCallback, useEffect, useState } from "react";
import { useSettingsTab } from "../../lib/settingsNav.ts";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { CloudError, DEFAULT_WORKSPACE_SETTINGS, type WorkspaceCloudSettings } from "../../lib/cloud.ts";
import { confirmAction, listSkills, type SkillInfo } from "../../lib/native.ts";
import { exportSkills } from "../../lib/system.ts";
import { Button, IconButton, Spinner, TextInput, openExternal } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { ErrorText, Pill, Row, SavedNote, Section, Select, Tabs, ToggleRow, useSaved } from "./parts.tsx";

type Tab = "environment" | "keys" | "skills" | "cleanup";

export function CloudPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useSettingsTab<Tab>("cloud", "environment", ["environment", "keys", "skills", "cleanup"]);
  const [ws, setWs] = useState<WorkspaceCloudSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, markSaved] = useSaved();
  const api = ctx.cloudApi;

  const load = useCallback(() => {
    if (!api) return;
    setError(null);
    api.workspaceSettings().then(setWs, err => {
      // An older server without workspace settings: show the defaults, read-only.
      setWs(DEFAULT_WORKSPACE_SETTINGS);
      setError(
        err instanceof CloudError && err.status === 404
          ? "This server doesn't support cloud environment settings yet. Update it to change these."
          : String(err),
      );
    });
  }, [api]);
  useEffect(load, [load]);

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
    setError(null);
    setWs(w => (w ? { ...w, ...patch } : w));
    try {
      setWs(await api.saveWorkspaceSettings(patch));
      markSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      load();
    }
  };

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
      <ErrorText>{error}</ErrorText>
      {ws?.canEdit === false && (
        <p className="mb-4 rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">
          Only the workspace's owner can change these. You can see what new sandboxes start with.
        </p>
      )}
      {!ws ? (
        <p className="text-[14px] text-ink-soft">Loading…</p>
      ) : (
        <>
          {tab === "environment" && <EnvironmentTab ws={ws} onSave={save} />}
          {tab === "keys" && <KeysTab ctx={ctx} />}
          {tab === "skills" && <SkillsTab ctx={ctx} ws={ws} onSynced={load} />}
          {tab === "cleanup" && <CleanupTab ws={ws} onSave={save} dashboard={ctx.settings.controlPlaneUrl} />}
        </>
      )}
    </>
  );
}

function EnvironmentTab({ ws, onSave }: { ws: WorkspaceCloudSettings; onSave: (p: Partial<WorkspaceCloudSettings>) => Promise<void> }) {
  const [instructions, setInstructions] = useState(ws.instructions);
  const [script, setScript] = useState(ws.setupScript);
  const area =
    "w-full resize-y rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf";
  return (
    <>
      <Section title="Setup script" description="Runs once in every new cloud sandbox, before the agent starts. Its output goes to the thread's log.">
        <textarea
          aria-label="Setup script"
          value={script}
          onChange={e => setScript(e.target.value)}
          onBlur={() => script !== ws.setupScript && void onSave({ setupScript: script })}
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
              disabled={script.includes(line!)}
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
        />
        <Row label="When a limit is hit, wait and try again" description="Up to this long; then the thread stops and tells you.">
          <Select
            label="When a limit is hit, wait and try again"
            value={String(ws.retryMaxWaitMinutes)}
            onChange={v => void onSave({ retryMaxWaitMinutes: Number(v) })}
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

function KeysTab({ ctx }: { ctx: SettingsCtx }) {
  const api = ctx.cloudApi!;
  const [list, setList] = useState<{ name: string; updatedAt: string }[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void api.listSecrets().then(setList, e => setError(String(e))), [api]);
  useEffect(load, [load]);
  const add = async () => {
    const n = name.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(n)) return setError("Names are letters, numbers and underscores, like OPENAI_API_KEY.");
    if (!value) return setError("Enter the value.");
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
      {list === null && <p className="text-[14px] text-ink-soft">Loading…</p>}
      {list?.length === 0 && <p className="text-[14px] text-ink-soft">None yet.</p>}
      {list?.map(s => (
        <Row key={s.name} label={<span className="font-mono text-[14px]">{s.name}</span>} description={`Changed ${new Date(s.updatedAt).toLocaleDateString()}`}>
          <IconButton label={`Delete ${s.name}`} onClick={() => void remove(s.name)}>
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
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
          Value
          <TextInput type="password" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" className="font-mono text-[13px]" />
        </label>
        <Button onClick={() => void add()} disabled={busy}>
          {busy && <Spinner />}
          Add
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function SkillsTab({ ctx, ws, onSynced }: { ctx: SettingsCtx; ws: WorkspaceCloudSettings; onSynced: () => void }) {
  const [mine, setMine] = useState<SkillInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(ws.skills.map(s => s.name)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, markSaved] = useSaved();
  useEffect(() => {
    void listSkills().then(list => setMine(list.filter(s => s.source === "yours")));
  }, []);
  const sync = async () => {
    setBusy(true);
    setError(null);
    try {
      const skills = await exportSkills([...picked]);
      await ctx.cloudApi!.saveWorkspaceSkills(skills);
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
      {mine === null && <p className="text-[14px] text-ink-soft">Loading…</p>}
      {mine?.length === 0 && <p className="text-[14px] text-ink-soft">You have no skills of your own yet. Add some on the Skills page.</p>}
      {mine?.map(s => (
        <ToggleRow key={s.name} label={s.name} description={s.description || undefined} checked={picked.has(s.name)} onChange={v => toggle(s.name, v)} />
      ))}
      {ws.skills.some(s => !mine?.some(m => m.name === s.name)) && (
        <p className="text-[14px] text-ink-soft">
          Also in the cloud, from another computer:{" "}
          {ws.skills
            .filter(s => !mine?.some(m => m.name === s.name))
            .map(s => s.name)
            .join(", ")}
          .
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button variant="primary" onClick={() => void sync()} disabled={busy || mine === null}>
          {busy && <Spinner />}
          Sync to the cloud
        </Button>
        <Button variant="ghost" onClick={() => setPicked(new Set(mine?.map(s => s.name) ?? []))}>
          Select all
        </Button>
        <Button variant="ghost" onClick={() => setPicked(new Set())}>
          Clear
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function CleanupTab({
  ws,
  onSave,
  dashboard,
}: {
  ws: WorkspaceCloudSettings;
  onSave: (p: Partial<WorkspaceCloudSettings>) => Promise<void>;
  dashboard: string;
}) {
  return (
    <Section title="Clean up" description="Old cloud threads keep their sandbox's disk. Clearing them out keeps the workspace tidy.">
      <Row
        label="Delete unused cloud threads after"
        description="Threads with no activity for this long are archived and their sandbox deleted. Their branches stay on GitHub."
      >
        <Select
          label="Delete unused cloud threads after"
          value={ws.autoDeleteDays === null ? "never" : String(ws.autoDeleteDays)}
          onChange={v => void onSave({ autoDeleteDays: v === "never" ? null : Number(v) })}
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
