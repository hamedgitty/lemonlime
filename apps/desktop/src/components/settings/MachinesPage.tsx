import { useState, type KeyboardEvent } from "react";
import { CircleAlert, CircleCheck, PencilLine, Plus, Trash2 } from "lucide-react";
import { addMachine, cleanMachineInput, removeMachine, saveMachines, updateMachine, useMachines, type Machine, type MachineInput } from "../../lib/machines.ts";
import { checkSshMachine, confirmAction, inDesktopShell, type SshCheck } from "../../lib/native.ts";
import { Button, IconButton, Spinner, TextInput } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { code, ErrorText, Section } from "./parts.tsx";
import { composing } from "../../lib/ime.ts";

const EMPTY: MachineInput = { name: "", host: "", runnerPath: "" };

/** Settings → Machines: the user's other computers, for threads over SSH. */
export function MachinesPage({ ctx }: { ctx: SettingsCtx }) {
  const machines = useMachines();
  const [editing, setEditing] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, SshCheck | "checking">>({});
  const shell = inDesktopShell();
  const inUse = (id: string) => ctx.localThreads.filter(t => t.machine === id).length;

  const check = async (m: Machine) => {
    setChecks(c => ({ ...c, [m.id]: "checking" }));
    let result: SshCheck;
    try {
      result = await checkSshMachine(m.host, m.runnerPath);
    } catch (err) {
      result = { ok: false, version: null, message: err instanceof Error ? err.message : String(err) };
    }
    setChecks(c => ({ ...c, [m.id]: result }));
  };

  const remove = async (m: Machine) => {
    const n = inUse(m.id);
    const ok = await confirmAction(
      n > 0
        ? `Remove ${m.name}? ${n === 1 ? "One thread runs" : `${n} threads run`} there; they can't start again until you add the machine back.`
        : `Remove ${m.name} from LemonLime? Nothing on that machine changes.`,
    );
    if (ok) saveMachines(removeMachine(machines, m.id));
  };

  return (
    <>
      <Section
        title="Your machines"
        description="Run threads on another computer of yours over SSH: a home server, a dev box, or one on your Tailscale network. LemonLime uses your own SSH config, keys and agent, and never asks for a password."
      >
        {!shell && <p className="text-[14px] text-ink-soft">Machines work in the desktop app.</p>}
        {machines.length === 0 && <p className="text-[14px] text-ink-soft">No machines yet. Add one below.</p>}
        {machines.map(m =>
          editing === m.id ? (
            <MachineForm
              key={m.id}
              initial={{ name: m.name, host: m.host, runnerPath: m.runnerPath }}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={value => {
                saveMachines(updateMachine(machines, m.id, value));
                setEditing(null);
                setChecks(c => Object.fromEntries(Object.entries(c).filter(([id]) => id !== m.id)));
              }}
            />
          ) : (
            <MachineRow
              key={m.id}
              machine={m}
              threads={inUse(m.id)}
              check={checks[m.id]}
              disabled={!shell}
              onCheck={() => void check(m)}
              onEdit={() => setEditing(m.id)}
              onRemove={() => void remove(m)}
            />
          ),
        )}
        <div className="border-t border-line pt-4">
          <MachineForm initial={EMPTY} submitLabel="Add machine" onSubmit={value => saveMachines(addMachine(machines, value))} />
        </div>
      </Section>

      <Section title="What the machine needs">
        <ul className="list-disc space-y-1.5 pl-5 text-[14px] text-pretty text-ink-soft">
          <li>
            SSH that works without a password from this computer: check with <code className={code}>ssh -o BatchMode=yes your-host true</code> in a terminal.
          </li>
          <li>Git, and the project already cloned there.</li>
          <li>The agent's CLI installed and signed in there (Claude Code, Codex, or OpenCode).</li>
          <li>
            The runner: a LemonLime checkout with Node 22 or newer (runner path{" "}
            <code className={code}>~/lemonlime/packages/runner/bin/lemonlime-runner.js</code>), or the single-file runner built for that machine with{" "}
            <code className={code}>pnpm --filter @lemonlime/runner build:sea</code>.
          </li>
        </ul>
        <p className="text-[14px] text-pretty text-ink-soft">
          Threads there work in their own git worktree, like threads on this computer. Opening a folder in your editor and computer access only work for threads
          on this computer.
        </p>
      </Section>
    </>
  );
}

function MachineRow({
  machine,
  threads,
  check,
  disabled,
  onCheck,
  onEdit,
  onRemove,
}: {
  machine: Machine;
  threads: number;
  check: SshCheck | "checking" | undefined;
  disabled: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-[240px]">
          <p className="truncate text-[15px] text-ink">{machine.name}</p>
          <p className="mt-0.5 truncate text-[14px] text-ink-soft">
            <code className={code}>{machine.host}</code>
            {machine.runnerPath ? (
              <>
                {", runner at "}
                <code className={code}>{machine.runnerPath}</code>
              </>
            ) : null}
            {threads > 0 ? `, ${threads === 1 ? "1 thread" : `${threads} threads`}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" onClick={onCheck} disabled={disabled || check === "checking"}>
            {check === "checking" && <Spinner />}
            Check
          </Button>
          <IconButton label={`Edit ${machine.name}`} onClick={onEdit}>
            <PencilLine aria-hidden="true" className="size-4" />
          </IconButton>
          <IconButton label={`Remove ${machine.name}`} onClick={onRemove}>
            <Trash2 aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </div>
      {check && check !== "checking" && (
        <p role="status" className="flex items-start gap-2 text-[14px] text-pretty whitespace-pre-line text-ink">
          {check.ok ? (
            <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-leaf" />
          ) : (
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          )}
          <span className="min-w-0 break-words">{check.message}</span>
        </p>
      )}
    </div>
  );
}

function MachineForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: MachineInput;
  submitLabel: string;
  onSubmit: (value: MachineInput) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const r = cleanMachineInput(form);
    if ("error" in r) return setError(r.error);
    setError(null);
    onSubmit(r.value);
    setForm(EMPTY);
  };
  const onKey = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === "Enter") submit();
    if (e.key === "Escape" && onCancel) onCancel();
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[13px] text-ink-soft">
          Name
          <TextInput
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            onKeyDown={onKey}
            placeholder="Home server"
            className="w-[160px]"
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
          Host
          <TextInput
            value={form.host}
            onChange={e => setForm({ ...form, host: e.target.value })}
            onKeyDown={onKey}
            placeholder="devbox or you@host:22"
            className="font-mono text-[13px]"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
          Runner path (optional)
          <TextInput
            value={form.runnerPath}
            onChange={e => setForm({ ...form, runnerPath: e.target.value })}
            onKeyDown={onKey}
            placeholder="lemonlime-runner"
            className="font-mono text-[13px]"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
        <Button onClick={submit}>
          {!onCancel && <Plus aria-hidden="true" className="size-4" />}
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
