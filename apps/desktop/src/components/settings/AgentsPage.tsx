import { useState } from "react";
import { Copy, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AGENT_LABELS } from "../../lib/format.ts";
import { inDesktopShell } from "../../lib/native.ts";
import { compareVersions, installAgent, TESTED_AGENTS, type AgentInstall } from "../../lib/system.ts";
import type { Settings, UiPrefs } from "../../lib/storage.ts";
import { Button, IconButton, Spinner, TextInput } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { code, ErrorText, Pill, Row, Section, Select, Tabs, ToggleRow } from "./parts.tsx";

type Tab = "installed" | "defaults" | "guard" | "acp" | "retry";

export function AgentsPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useState<Tab>("installed");
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "installed", label: "Installed" },
          { id: "defaults", label: "Defaults" },
          { id: "guard", label: "Command guard" },
          { id: "acp", label: "ACP agents", count: ctx.settings.acpAgents.length },
          { id: "retry", label: "Retry" },
        ]}
      />
      {tab === "installed" && <InstalledTab ctx={ctx} />}
      {tab === "defaults" && <DefaultsTab ctx={ctx} />}
      {tab === "guard" && <GuardTab ctx={ctx} />}
      {tab === "acp" && <AcpTab ctx={ctx} />}
      {tab === "retry" && <RetryTab ctx={ctx} />}
    </>
  );
}

/** "Update" when the installed CLI is older than the version LemonLime is tested with. */
export function needsUpdate(a: AgentInstall): boolean {
  const tested = TESTED_AGENTS.find(t => t.kind === a.kind);
  return Boolean(a.installed && a.version && tested && compareVersions(a.version, tested.version) < 0);
}

function InstalledTab({ ctx }: { ctx: SettingsCtx }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ kind: string; ok: boolean; text: string } | null>(null);
  const shell = inDesktopShell();
  const run = async (kind: AgentInstall["kind"]) => {
    setBusy(kind);
    setOutput(null);
    try {
      const text = await installAgent(kind);
      setOutput({ kind, ok: true, text });
    } catch (err) {
      setOutput({ kind, ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      ctx.refreshAgents();
    }
  };
  const found = ctx.agents ?? [];
  const isDefault = (kind: string) => ctx.prefs.lastAgent === kind;
  return (
    <>
      <Section
        title="Agents on this computer"
        description="Agents run with your own account. Sign each one in once here; cloud sandboxes sign in on their own."
        aside={
          <IconButton label="Check again" onClick={ctx.refreshAgents} disabled={!shell || ctx.agents === null}>
            {ctx.agents === null ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-4" />}
          </IconButton>
        }
      >
        {!shell && <p className="text-[14px] text-ink-soft">Agent detection works in the desktop app.</p>}
        {TESTED_AGENTS.map(t => {
          const a = found.find(f => f.kind === t.kind);
          const outdated = a ? needsUpdate(a) : false;
          return (
            <div key={t.kind} className="flex flex-col gap-2">
              <Row
                label={
                  <span className="inline-flex items-center gap-2">
                    {AGENT_LABELS[t.kind]}
                    {isDefault(t.kind) && <Pill tone="good">Default</Pill>}
                  </span>
                }
                description={
                  !a ? (
                    shell ? (
                      "Looking…"
                    ) : (
                      `Tested with ${t.version}.`
                    )
                  ) : !a.installed ? (
                    "Not installed."
                  ) : (
                    <>
                      {a.version ? `Version ${a.version}` : "Installed"}
                      {outdated ? `; LemonLime is tested with ${t.version}.` : "."}{" "}
                      {a.signedIn === false && (
                        <>
                          Sign in with <code className={code}>{t.signIn}</code> in a terminal.
                        </>
                      )}
                    </>
                  )
                }
              >
                {a?.installed && a.signedIn !== null && <Pill tone={a.signedIn ? "good" : "warn"}>{a.signedIn ? "Signed in" : "Not signed in"}</Pill>}
                {a && !a.installed && (
                  <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void run(t.kind)}>
                    {busy === t.kind && <Spinner />}
                    Install
                  </Button>
                )}
                {a?.installed && (
                  <Button size="sm" variant={outdated ? "primary" : "secondary"} disabled={busy !== null} onClick={() => void run(t.kind)}>
                    {busy === t.kind && <Spinner />}
                    {outdated ? "Update" : "Reinstall latest"}
                  </Button>
                )}
                {a?.installed && !isDefault(t.kind) && (
                  <Button size="sm" variant="ghost" onClick={() => ctx.onPrefs({ lastAgent: t.kind })}>
                    Make default
                  </Button>
                )}
                {a?.signedIn === false && (
                  <IconButton label={`Copy ${t.signIn}`} onClick={() => void navigator.clipboard?.writeText(t.signIn)}>
                    <Copy aria-hidden="true" className="size-4" />
                  </IconButton>
                )}
              </Row>
              {output?.kind === t.kind && (
                <pre
                  role="status"
                  className={`max-h-48 overflow-auto rounded-lg border px-3 py-2 font-mono text-[12px] whitespace-pre-wrap ${output.ok ? "border-line bg-cream" : "border-danger/30 bg-danger-soft text-danger"}`}
                >
                  {output.ok ? `Done.\n${output.text}` : output.text}
                </pre>
              )}
            </div>
          );
        })}
        <p className="border-t border-line pt-4 text-[13.5px] text-ink-soft">
          Installing uses npm, which comes with Node.js. Any agent that speaks the Agent Client Protocol works too: add it under ACP agents.
        </p>
      </Section>
    </>
  );
}

function DefaultsTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave, prefs, onPrefs } = ctx;
  return (
    <Section title="Defaults">
      <Row label="Start new threads on" description="The place picked when you open a new thread.">
        <Select<UiPrefs["defaultPlace"]>
          label="Start new threads on"
          value={prefs.defaultPlace}
          onChange={defaultPlace => onPrefs({ defaultPlace, ...(defaultPlace !== "last" ? { lastPlace: defaultPlace } : {}) })}
          options={[
            { value: "last", label: "Wherever I used last" },
            { value: "local", label: "This computer" },
            { value: "cloud", label: "The cloud" },
          ]}
        />
      </Row>
      <Row label="Default agent">
        <Select<UiPrefs["lastAgent"]>
          label="Default agent"
          value={prefs.lastAgent}
          onChange={lastAgent => onPrefs({ lastAgent })}
          options={(["claude-code", "codex", "opencode", "acp"] as const).map(k => ({ value: k, label: AGENT_LABELS[k] }))}
        />
      </Row>
      <ToggleRow
        label="Remove AI co-author lines"
        description="Agents' commits on this computer won't carry “Co-authored-by” lines. Applies to threads started after you change it."
        checked={settings.stripCoauthors}
        onChange={stripCoauthors => onSave({ ...settings, stripCoauthors })}
      />
      <Row label="Branch names start with" htmlFor="branch-prefix" description="For new threads on this computer. Cloud threads always use agent/.">
        <BranchPrefix settings={settings} onSave={onSave} />
      </Row>
      <ToggleRow
        label="Offer the highest reasoning levels"
        description="Adds the slowest, most thorough levels to the picker. They use much more of your plan."
        checked={prefs.showMaxReasoning}
        onChange={showMaxReasoning => onPrefs({ showMaxReasoning })}
      />
    </Section>
  );
}

function BranchPrefix({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [value, setValue] = useState(settings.branchPrefix);
  const valid = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/.test(value) && !value.includes("..") && !value.startsWith("-");
  return (
    <div className="flex flex-col items-end gap-1">
      <TextInput
        id="branch-prefix"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={() => valid && value !== settings.branchPrefix && onSave({ ...settings, branchPrefix: value.endsWith("/") ? value : `${value}/` })}
        className="w-[200px] font-mono text-[13px]"
        spellCheck={false}
        aria-invalid={!valid}
      />
      {!valid && <span className="text-[12.5px] text-danger">Letters, numbers, dots, dashes and slashes only.</span>}
    </div>
  );
}

function GuardTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  return (
    <Section title="Command guard" description="A last line of defence that refuses a short list of commands that can't be undone, even at full autonomy.">
      <ToggleRow
        label="Block destructive commands"
        description="Deleting your home folder, wiping a disk, deleting hosted repositories, fork bombs and the like. Applies to threads started after you change it."
        checked={settings.commandGuard}
        onChange={commandGuard => onSave({ ...settings, commandGuard })}
      />
      {!settings.commandGuard && (
        <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[13.5px]">Agents on this computer can now run these commands without being stopped.</p>
      )}
    </Section>
  );
}

function AcpTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    if (!name.trim() || !command.trim()) return setError("Give it a name and the command that starts it.");
    if (settings.acpAgents.some(a => a.name.toLowerCase() === name.trim().toLowerCase())) return setError("You already have an agent with that name.");
    setError(null);
    onSave({ ...settings, acpAgents: [...settings.acpAgents, { id: crypto.randomUUID(), name: name.trim(), command: command.trim() }] });
    setName("");
    setCommand("");
  };
  return (
    <Section
      title="ACP agents"
      description="Any agent that speaks the Agent Client Protocol. Saved ones appear in the agent picker, so you don't type the command each time."
    >
      {settings.acpAgents.length === 0 && <p className="text-[14px] text-ink-soft">None saved yet.</p>}
      {settings.acpAgents.map(a => (
        <Row key={a.id} label={a.name} description={<code className={code}>{a.command}</code>}>
          <IconButton label={`Remove ${a.name}`} onClick={() => onSave({ ...settings, acpAgents: settings.acpAgents.filter(x => x.id !== a.id) })}>
            <Trash2 aria-hidden="true" className="size-4" />
          </IconButton>
        </Row>
      ))}
      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
        <label className="flex flex-col gap-1 text-[13px] text-ink-soft">
          Name
          <TextInput value={name} onChange={e => setName(e.target.value)} placeholder="Gemini" className="w-[160px]" />
        </label>
        <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
          Command
          <TextInput
            value={command}
            onChange={e => setCommand(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()}
            placeholder="gemini --experimental-acp"
            className="font-mono text-[13px]"
            spellCheck={false}
          />
        </label>
        <Button onClick={add}>
          <Plus aria-hidden="true" className="size-4" />
          Add
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

const WAITS = [
  { value: "0", label: "Don't retry" },
  { value: "15", label: "Up to 15 minutes" },
  { value: "60", label: "Up to 1 hour" },
  { value: "180", label: "Up to 3 hours" },
  { value: "360", label: "Up to 6 hours" },
  { value: "720", label: "Up to 12 hours" },
  { value: "1440", label: "Up to a day" },
];

function RetryTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  return (
    <Section
      title="Automatic retry"
      description="When the provider is busy or you hit a usage limit, the agent waits and carries on by itself, instead of stopping the thread."
    >
      <Row
        label="Wait and try again"
        description="If a limit resets later than this, the thread stops and tells you. Applies to threads started after you change it."
      >
        <Select
          label="Wait and try again"
          value={String(settings.retryMaxWaitMinutes)}
          onChange={v => onSave({ ...settings, retryMaxWaitMinutes: Number(v) })}
          options={
            WAITS.some(w => w.value === String(settings.retryMaxWaitMinutes))
              ? WAITS
              : [...WAITS, { value: String(settings.retryMaxWaitMinutes), label: `Up to ${settings.retryMaxWaitMinutes} minutes` }]
          }
        />
      </Row>
    </Section>
  );
}
