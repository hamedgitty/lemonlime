import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Cloud, ExternalLink, FolderOpen, Laptop, X } from "lucide-react";
import { SANDBOX_RESOURCES, type AgentKind, type PolicyDenied, type SandboxSize } from "@lemonlime/protocol";
import { AGENT_LABELS } from "../lib/format.ts";
import { inDesktopShell, inspectRepo, pickFolder } from "../lib/native.ts";
import { splitCommand } from "../lib/command.ts";
import { Button, Field, SegmentedControl, Spinner, TextInput, cx, inputClass, openExternal } from "./ui.tsx";

export interface NewLocalThread {
  mode: "local";
  title: string;
  agent: AgentKind;
  agentCommand: string[] | undefined;
  model: string | undefined;
  repoPath: string;
  baseBranch: string;
  prompt: string | undefined;
}

export interface NewCloudThread {
  mode: "cloud";
  title: string;
  agent: AgentKind;
  agentCommand: string[] | undefined;
  model: string | undefined;
  repoUrl: string;
  baseBranch: string;
  sandboxSize: SandboxSize;
  prompt: string | undefined;
}

export type NewThreadInput = NewLocalThread | NewCloudThread;

/** Thrown by `onCreate` to show a policy denial instead of a plain error. */
export class DeniedError extends Error {
  constructor(readonly denial: PolicyDenied) {
    super(denial.reason);
  }
}

const AGENTS: AgentKind[] = ["claude-code", "codex", "opencode", "acp"];
const AGENT_HINTS: Record<AgentKind, string> = {
  "claude-code": "Uses your Claude account",
  codex: "Uses your OpenAI account",
  opencode: "Uses the providers you set up in OpenCode",
  acp: "Any Agent Client Protocol agent",
};

export function NewThreadDialog({
  cloudAvailable,
  onCancel,
  onCreate,
}: {
  cloudAvailable: boolean;
  onCancel: () => void;
  onCreate: (input: NewThreadInput) => Promise<void>;
}) {
  const titleId = useId();
  const shell = inDesktopShell();
  const [mode, setMode] = useState<"local" | "cloud">(shell || !cloudAvailable ? "local" : "cloud");
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const [agentCommand, setAgentCommand] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [sandboxSize, setSandboxSize] = useState<SandboxSize>("small");
  const [repoError, setRepoError] = useState<string | null>(null);
  const [checkingRepo, setCheckingRepo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denial, setDenial] = useState<PolicyDenied | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [href]';

  // Focus the first control on open and give focus back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = firstRef.current && !firstRef.current.disabled ? firstRef.current : null;
    (first ?? dialogRef.current?.querySelector<HTMLElement>(`input:not(.sr-only), textarea`) ?? dialogRef.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  // Escape closes, wherever focus is.
  const submittingRef = useRef(false);
  submittingRef.current = submitting;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !submittingRef.current) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Tab stays inside the dialog.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const visible = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      el => el.offsetParent !== null || el.classList.contains("sr-only"),
    );
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const chooseFolder = async () => {
    setRepoError(null);
    try {
      const path = await pickFolder();
      if (!path) return;
      setRepoPath(path);
      setCheckingRepo(true);
      const info = await inspectRepo(path);
      if (info.branch) setBaseBranch(info.branch);
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingRepo(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDenial(null);

    const words = agent === "acp" ? splitCommand(agentCommand) : [];
    if (agent === "acp" && words.length === 0) return setError("Enter the command that starts your ACP agent.");
    if (mode === "local" && !repoPath) return setError("Choose the repository folder the agent should work in.");
    if (mode === "local" && repoError) return setError(repoError);
    if (mode === "cloud" && !repoUrl.trim()) return setError("Enter the repository's clone URL.");
    if (!baseBranch.trim()) return setError("Enter the branch the agent should start from.");

    const common = {
      title: title.trim(),
      agent,
      agentCommand: agent === "acp" ? words : undefined,
      model: model.trim() || undefined,
      baseBranch: baseBranch.trim(),
      prompt: prompt.trim() || undefined,
    };
    setSubmitting(true);
    try {
      await onCreate(
        mode === "local"
          ? { mode, ...common, repoPath }
          : { mode, ...common, repoUrl: repoUrl.trim(), sandboxSize },
      );
    } catch (err) {
      if (err instanceof DeniedError) setDenial(err.denial);
      else setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-rind/40 p-6 pt-[8vh] backdrop-blur-[2px]"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-[600px] animate-rise focus:outline-none rounded-2xl border border-line bg-white shadow-pop"
      >
        <form onSubmit={submit} noValidate>
          <div className="flex items-center justify-between border-b border-line px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              New thread
            </h2>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-ink/5 hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>

          <div className="flex flex-col gap-5 px-6 py-5">
            <Field label="Where should it run?">
              <SegmentedControl
                label="Where should it run?"
                value={mode}
                onChange={setMode}
                options={[
                  {
                    value: "local",
                    label: (
                      <>
                        <Laptop aria-hidden="true" className="size-4" /> This computer
                      </>
                    ),
                    disabled: !shell,
                    ...(shell ? {} : { hint: "Local threads need the desktop app" }),
                  },
                  {
                    value: "cloud",
                    label: (
                      <>
                        <Cloud aria-hidden="true" className="size-4" /> Cloud sandbox
                      </>
                    ),
                    disabled: !cloudAvailable,
                    ...(cloudAvailable ? {} : { hint: "Connect a control plane in Settings first" }),
                  },
                ]}
              />
            </Field>

            {mode === "local" ? (
              <Field label="Repository" error={repoError} hint="The agent works on its own branch in this folder.">
                <div className="flex gap-2">
                  <div
                    className={cx(
                      inputClass,
                      "flex min-h-[38px] min-w-0 flex-1 items-center truncate",
                      repoPath ? "font-mono text-[12.5px]" : "text-ink-faint",
                    )}
                    title={repoPath || undefined}
                    aria-live="polite"
                  >
                    {repoPath || "No folder chosen"}
                  </div>
                  <Button ref={firstRef} onClick={chooseFolder} disabled={!shell || checkingRepo}>
                    {checkingRepo ? <Spinner /> : <FolderOpen aria-hidden="true" className="size-4" />}
                    Choose folder
                  </Button>
                </div>
              </Field>
            ) : (
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label="Repository URL" htmlFor="repo-url">
                  <TextInput
                    id="repo-url"
                    value={repoUrl}
                    onChange={e => setRepoUrl(e.target.value)}
                    placeholder="https://example.com/you/project.git"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Sandbox">
                  <SegmentedControl
                    label="Sandbox size"
                    value={sandboxSize}
                    onChange={setSandboxSize}
                    options={(["small", "large"] as const).map(s => ({
                      value: s,
                      label: `${SANDBOX_RESOURCES[s].vcpu} vCPU · ${SANDBOX_RESOURCES[s].memoryGiB} GB`,
                    }))}
                  />
                </Field>
              </div>
            )}

            <Field label="Start from branch" htmlFor="base-branch">
              <TextInput
                id="base-branch"
                value={baseBranch}
                onChange={e => setBaseBranch(e.target.value)}
                className="font-mono text-[13px]"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-[13px] font-medium text-ink">Agent</legend>
              <div className="grid grid-cols-2 gap-2">
                {AGENTS.map(kind => (
                  <label
                    key={kind}
                    className={cx(
                      "flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-leaf",
                      agent === kind ? "border-leaf bg-lime-soft/60" : "border-line-strong hover:bg-cream",
                    )}
                  >
                    <input
                      type="radio"
                      name="agent"
                      value={kind}
                      checked={agent === kind}
                      onChange={() => setAgent(kind)}
                      className="sr-only"
                    />
                    <span className="text-sm font-medium text-ink">{AGENT_LABELS[kind]}</span>
                    <span className="text-xs text-ink-soft">{AGENT_HINTS[kind]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {agent === "acp" && (
              <Field label="Agent command" htmlFor="agent-command" hint="The command that starts the agent in ACP mode.">
                <TextInput
                  id="agent-command"
                  value={agentCommand}
                  onChange={e => setAgentCommand(e.target.value)}
                  placeholder="gemini --experimental-acp"
                  className="font-mono text-[13px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Model" optional htmlFor="model">
                <TextInput
                  id="model"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder="Agent default"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field label="Title" optional htmlFor="title">
                <TextInput id="title" value={title} onChange={e => setTitle(e.target.value)} placeholder="From the first prompt" />
              </Field>
            </div>

            <Field label="First prompt" optional htmlFor="prompt">
              <textarea
                id="prompt"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={4}
                placeholder="What should the agent work on?"
                className={cx(inputClass, "resize-y leading-relaxed")}
              />
            </Field>

            {denial && (
              <div className="flex items-start gap-3 rounded-xl border border-[#f0d95c] bg-lemon-soft px-4 py-3 text-[13.5px]" role="alert">
                <p className="min-w-0 flex-1 text-ink">{denial.reason}</p>
                {denial.actionUrl && (
                  <Button size="sm" onClick={() => void openExternal(denial.actionUrl!)}>
                    {denial.actionLabel || "Learn more"}
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                  </Button>
                )}
              </div>
            )}
            {error && (
              <p className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[13.5px] text-ink" role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line bg-cream/50 px-6 py-3.5">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting && <Spinner />}
              Start thread
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
