import { useEffect, useState } from "react";
import { AGENT_CAPABILITIES, ON_LIMIT_LABELS, OnLimit, type AgentKind, type ReasoningLevel } from "@lemonlime/protocol";
import { listAccounts, setOnLimit } from "../../lib/accounts.ts";
import { AccountsTab } from "./AccountsTab.tsx";
import { HarnessTab } from "./HarnessTab.tsx";
import { Copy, Plus, Trash2 } from "lucide-react";
import { AGENT_LABELS } from "../../lib/format.ts";
import { effortLevels, needsUpdate } from "../../lib/models.ts";
import { inDesktopShell } from "../../lib/native.ts";
import { AGENTS_TAB_EVENT, takeAgentsTab, type AgentsTab, type AgentsTabRequest } from "../../lib/settingsNav.ts";
import { TESTED_AGENTS } from "../../lib/system.ts";
import type { Settings, UiPrefs } from "../../lib/storage.ts";
import { defaultModel, EFFORT_LABELS } from "../ModelControl.tsx";
import { Button, IconButton, TextInput } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { code, ErrorText, Row, Section, Select, Tabs, ToggleRow } from "./parts.tsx";

const TABS: { id: AgentsTab; label: string }[] = [
  { id: "harness", label: "Harness" },
  { id: "accounts", label: "Accounts" },
  { id: "defaults", label: "Defaults" },
  { id: "guard", label: "Command guard" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "acp", label: "ACP agents" },
  { id: "retry", label: "Limits" },
];

export function AgentsPage({ ctx }: { ctx: SettingsCtx }) {
  const [asked] = useState(takeAgentsTab);
  const [tab, setTab] = useState<AgentsTab>(asked?.tab ?? "harness");
  const [accountsFor, setAccountsFor] = useState<AgentKind | undefined>(asked?.agent);
  const show = (req: AgentsTabRequest) => {
    setTab(req.tab);
    if (req.agent) setAccountsFor(req.agent);
  };
  // Asked for while the page is already open (the model picker's "+").
  useEffect(() => {
    const on = (e: Event) => {
      takeAgentsTab();
      show((e as CustomEvent<AgentsTabRequest>).detail);
    };
    window.addEventListener(AGENTS_TAB_EVENT, on);
    return () => window.removeEventListener(AGENTS_TAB_EVENT, on);
  }, []);
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={TABS.map(t => (t.id === "acp" ? { ...t, count: ctx.settings.acpAgents.length } : t))} />
      {tab === "harness" && <HarnessTab ctx={ctx} onTab={show} />}
      {tab === "accounts" && <AccountsTab initialAgent={accountsFor} />}
      {tab === "defaults" && <DefaultsTab ctx={ctx} />}
      {tab === "guard" && <GuardTab ctx={ctx} />}
      {tab === "claude-code" && <AgentTab ctx={ctx} kind="claude-code" onTab={show} />}
      {tab === "codex" && <AgentTab ctx={ctx} kind="codex" onTab={show} />}
      {tab === "acp" && <AcpTab ctx={ctx} />}
      {tab === "retry" && <RetryTab ctx={ctx} />}
    </>
  );
}

/** One agent's own settings: what new threads start with, and how it's installed and signed in. */
function AgentTab({ ctx, kind, onTab }: { ctx: SettingsCtx; kind: "claude-code" | "codex"; onTab: (req: AgentsTabRequest) => void }) {
  const { prefs, onPrefs } = ctx;
  const caps = AGENT_CAPABILITIES[kind];
  const a = ctx.agents?.find(x => x.kind === kind);
  const tested = TESTED_AGENTS.find(t => t.kind === kind)!;
  const choice = prefs.agentChoices[kind] ?? { model: null, reasoning: null, fast: false };
  const set = (patch: Partial<typeof choice>) => onPrefs({ agentChoices: { ...prefs.agentChoices, [kind]: { ...choice, ...patch } } });
  const levels = effortLevels(kind, prefs.showMaxReasoning);
  const models = caps.models;
  const model = choice.model ?? defaultModel(kind) ?? "";
  return (
    <>
      <Section
        title={AGENT_LABELS[kind]}
        description={
          !inDesktopShell()
            ? `Tested with ${tested.version}.`
            : !a
              ? "Looking…"
              : !a.installed
                ? "Not installed on this computer. Install it from Harness."
                : `Version ${a.version ?? "unknown"}${needsUpdate(a) ? `, older than ${tested.version}, which LemonLime is tested with` : ""}.`
        }
        aside={
          <Button size="sm" variant="ghost" onClick={() => onTab({ tab: "harness" })}>
            Open Harness
          </Button>
        }
      >
        <Row
          label="Sign in"
          description={
            <>
              Run <code className={code}>{tested.signIn}</code> in a terminal, or add accounts under Accounts.
            </>
          }
        >
          <IconButton label={`Copy ${tested.signIn}`} onClick={() => void navigator.clipboard?.writeText(tested.signIn)}>
            <Copy aria-hidden="true" className="size-4" />
          </IconButton>
          <Button size="sm" variant="secondary" onClick={() => onTab({ tab: "accounts", agent: kind })}>
            Accounts…
          </Button>
        </Row>
      </Section>
      <Section
        title="New threads"
        description="What a new thread starts with. The model picker changes these as you pick, and a thread can change them as it goes."
      >
        <Row label="Model">
          <Select
            label="Model"
            value={models.some(m => m.id === model) ? model : ""}
            onChange={v => set({ model: v || null })}
            options={[
              ...(models.some(m => m.id === model) ? [] : [{ value: "", label: model || "The agent's default" }]),
              ...models.map(m => ({ value: m.id, label: m.context ? `${m.label} (${m.context})` : m.label })),
            ]}
          />
        </Row>
        <Row label="Effort" description="How hard it thinks. Higher is slower and uses more of your plan.">
          <Select
            label="Effort"
            value={choice.reasoning && levels.includes(choice.reasoning) ? choice.reasoning : ""}
            onChange={v => set({ reasoning: (v || null) as ReasoningLevel | null })}
            options={[{ value: "", label: "The agent's default" }, ...levels.map(r => ({ value: r, label: EFFORT_LABELS[r] }))]}
          />
        </Row>
        {caps.fast && (
          <ToggleRow
            label="Fast mode"
            description={`${AGENT_LABELS[kind]} answers faster on the models that support it, and uses more of your plan.`}
            checked={choice.fast}
            onChange={fast => set({ fast })}
          />
        )}
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
        label="Offer the highest effort levels"
        description="Adds the slowest, most thorough levels (Max) to the effort menu. They use much more of your plan."
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
      {!valid && <span className="text-[13px] text-danger">Letters, numbers, dots, dashes and slashes only.</span>}
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
        <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[14px]">Agents on this computer can now run these commands without being stopped.</p>
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

const ON_LIMIT_HINTS: Record<OnLimit, string> = {
  wait: "The thread waits for the limit to reset, then carries on by itself.",
  switch: "The thread carries on with your next signed-in account of the same agent, in the same conversation. If every account is out, it waits.",
  ask: "The thread stops and asks: switch account, carry on with another agent, or wait.",
};

function LimitPolicy() {
  const shell = inDesktopShell();
  const [value, setValue] = useState<OnLimit | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!shell) return;
    let live = true;
    void listAccounts()
      .then(l => live && l && setValue(l.onLimit))
      .catch(err => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [shell]);
  const change = (next: OnLimit) => {
    const before = value;
    setValue(next);
    setError(null);
    void setOnLimit(next).catch(err => {
      setValue(before);
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <>
      <Row
        label="When an agent hits its limit"
        description={value ? `${ON_LIMIT_HINTS[value]} Applies to threads on this computer straight away.` : shell ? "Looking…" : "Works in the desktop app."}
      >
        {value && (
          <Select<OnLimit>
            label="When an agent hits its limit"
            value={value}
            onChange={change}
            options={OnLimit.options.map(o => ({ value: o, label: ON_LIMIT_LABELS[o] }))}
          />
        )}
      </Row>
      <ErrorText>{error}</ErrorText>
    </>
  );
}

function RetryTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  return (
    <Section
      title="Limits and retries"
      description="When the provider is busy or you hit a usage limit, the thread carries on by itself instead of stopping. Add more accounts under Accounts to switch between them."
    >
      <LimitPolicy />
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
