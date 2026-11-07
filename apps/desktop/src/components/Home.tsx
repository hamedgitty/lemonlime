import { useRef, useState } from "react";
import { Bot, Cloud, ExternalLink, FolderOpen, FolderPlus, GitBranch, Laptop, Zap } from "lucide-react";
import { AGENT_CAPABILITIES, SANDBOX_RESOURCES, type AgentKind, type PolicyDenied, type ReasoningLevel, type SandboxSize } from "@lemonlime/protocol";
import { splitCommand } from "../lib/command.ts";
import { AGENT_LABELS, repoName } from "../lib/format.ts";
import { inDesktopShell, inspectRepo, pickFolder } from "../lib/native.ts";
import { DeniedError, type NewThreadInput } from "../lib/newThread.ts";
import type { UiPrefs } from "../lib/storage.ts";
import { Composer, PickerButton, type ComposerHandle } from "./Composer.tsx";
import { Menu, MenuChoice, MenuItem, MenuLabel, MenuSeparator, Popover } from "./primitives.tsx";
import { Button, SegmentedControl, TextInput, cx, openExternal } from "./ui.tsx";

const AGENTS: AgentKind[] = ["claude-code", "codex", "opencode", "acp"];
const AGENT_HINT: Record<AgentKind, string> = {
  "claude-code": "Your Claude account",
  codex: "Your ChatGPT or OpenAI account",
  opencode: "The providers you set up in OpenCode",
  acp: "Any Agent Client Protocol agent",
};

/** Ready-made first messages, shown to people who haven't started many threads yet. */
const STARTERS = [
  { label: "Find and fix a bug", prompt: "Look through this repository for a real bug, explain it, fix it, and add a test that would have caught it." },
  { label: "Add missing tests", prompt: "Find the most important code in this repository that has no tests, and write good tests for it. Run them." },
  { label: "Explain this codebase", prompt: "Explain how this codebase fits together: the main parts, how data flows, and where I should start reading." },
  {
    label: "Review my last commit",
    prompt: "Review the most recent commit on this branch like a careful senior engineer. List real problems, most important first.",
  },
];

export interface HomeProps {
  cloudAvailable: boolean;
  threadCount: number;
  prefs: UiPrefs;
  onPrefs: (patch: Partial<UiPrefs>) => void;
  onCreate: (input: NewThreadInput) => Promise<void>;
  onConnectCloud: () => void;
}

/**
 * The home screen is the composer: write what you want, pick the project and where it
 * runs underneath, send. Sending starts a thread.
 */
export function Home({ cloudAvailable, threadCount, prefs, onPrefs, onCreate, onConnectCloud }: HomeProps) {
  const composer = useRef<ComposerHandle>(null);
  const shell = inDesktopShell();
  const place = prefs.lastPlace === "cloud" && cloudAvailable ? "cloud" : "local";
  const agent = prefs.lastAgent;
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningLevel | "">("");
  const caps = AGENT_CAPABILITIES[agent];
  const [acpCommand, setAcpCommand] = useState("");
  const [repoPath, setRepoPath] = useState(prefs.recentProjects[0] ?? "");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [sandboxSize, setSandboxSize] = useState<SandboxSize>("small");
  const [projectOpen, setProjectOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denial, setDenial] = useState<PolicyDenied | null>(null);

  const pickProject = async (path: string) => {
    setError(null);
    setRepoPath(path);
    onPrefs({ recentProjects: [path, ...prefs.recentProjects.filter(p => p !== path)].slice(0, 8) });
    try {
      const info = await inspectRepo(path);
      if (info.branch) setBaseBranch(info.branch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseFolder = async () => {
    try {
      const path = await pickFolder();
      if (path) await pickProject(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const send = async (prompt: string) => {
    setError(null);
    setDenial(null);
    const words = agent === "acp" ? splitCommand(acpCommand) : [];
    if (agent === "acp" && words.length === 0) return setError("Enter the command that starts your ACP agent, under the agent picker.");
    if (place === "local" && !repoPath) {
      setProjectOpen(true);
      return setError("Choose the project folder the agent should work in.");
    }
    if (place === "cloud" && !repoUrl.trim()) {
      setProjectOpen(true);
      return setError("Enter the repository the cloud agent should clone.");
    }
    if (!baseBranch.trim()) return setError("Enter the branch the agent should start from.");
    const common = {
      title: "",
      agent,
      agentCommand: agent === "acp" ? words : undefined,
      model: model.trim() || undefined,
      reasoning: reasoning && caps.reasoning.includes(reasoning) ? reasoning : undefined,
      baseBranch: baseBranch.trim(),
      prompt,
    };
    setBusy(true);
    try {
      await onCreate(place === "local" ? { mode: "local", ...common, repoPath } : { mode: "cloud", ...common, repoUrl: repoUrl.trim(), sandboxSize });
    } catch (err) {
      if (err instanceof DeniedError) setDenial(err.denial);
      else setError(err instanceof Error ? err.message : String(err));
      composer.current?.fill(prompt);
    } finally {
      setBusy(false);
    }
  };

  const projectLabel = place === "local" ? (repoPath ? repoName(repoPath) : "Work in a project") : repoUrl.trim() ? repoName(repoUrl) : "Choose a repository";

  return (
    <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[740px] px-6 pt-[14vh] pb-16">
        <h1 className="mb-6 text-center font-display text-[30px] font-semibold tracking-[-0.03em] text-ink">What should your agent work on?</h1>
        <Composer
          ref={composer}
          autoFocus
          busy={busy}
          onSend={text => void send(text)}
          tools={
            <>
              <Menu
                trigger={
                  <PickerButton icon={<Bot />} aria-label={`Agent: ${AGENT_LABELS[agent]}`}>
                    {AGENT_LABELS[agent]}
                    {model.trim() ? <span className="font-normal text-ink-faint"> · {model.trim()}</span> : null}
                  </PickerButton>
                }
              >
                <MenuLabel>Agent</MenuLabel>
                <MenuChoice
                  value={agent}
                  onChange={a => onPrefs({ lastAgent: a })}
                  options={AGENTS.map(a => ({ value: a, label: <span>{AGENT_LABELS[a]}</span> }))}
                />
              </Menu>
              <Popover
                trigger={
                  <PickerButton tone="muted" aria-label="Model and agent options">
                    {model.trim() ? "Model" : "Default model"}
                  </PickerButton>
                }
                className="w-[320px] p-3"
              >
                <div className="space-y-3">
                  <p className="text-[13.5px] text-ink-soft">{AGENT_HINT[agent]}. Leave the model empty to use the agent's own default.</p>
                  <label className="block">
                    <span className="mb-1 block text-[13.5px] font-medium">Model</span>
                    <TextInput
                      value={model}
                      onChange={e => setModel(e.target.value)}
                      placeholder="Agent's default"
                      className="font-mono text-[13px]"
                      list={caps.models.length ? "lemonlime-models" : undefined}
                    />
                    {caps.models.length > 0 && (
                      <datalist id="lemonlime-models">
                        {caps.models.map(m => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </datalist>
                    )}
                  </label>
                  {caps.reasoning.length > 0 && (
                    <div>
                      <span className="mb-1 block text-[13.5px] font-medium">Thinking</span>
                      <SegmentedControl
                        label="Thinking"
                        value={reasoning || "default"}
                        onChange={v => setReasoning(v === "default" ? "" : (v as ReasoningLevel))}
                        options={[
                          { value: "default", label: "Default" },
                          ...caps.reasoning.slice(0, 4).map(r => ({ value: r, label: r === "xhigh" ? "Extra high" : r[0]!.toUpperCase() + r.slice(1) })),
                        ]}
                      />
                      <p className="mt-1 text-[12.5px] text-ink-faint">Fixed for this thread once it starts.</p>
                    </div>
                  )}
                  {agent === "acp" && (
                    <label className="block">
                      <span className="mb-1 block text-[13.5px] font-medium">Command that starts the agent</span>
                      <TextInput
                        value={acpCommand}
                        onChange={e => setAcpCommand(e.target.value)}
                        placeholder="gemini --experimental-acp"
                        className="font-mono text-[13px]"
                      />
                    </label>
                  )}
                </div>
              </Popover>
            </>
          }
        />

        {/* Context row: the project, and where the agent runs. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1 px-2">
          <Popover
            open={projectOpen}
            onOpenChange={setProjectOpen}
            trigger={
              <PickerButton icon={place === "local" ? <FolderPlus /> : <GitBranch />} tone={repoPath || repoUrl ? "plain" : "muted"}>
                {projectLabel}
                {(place === "local" ? repoPath : repoUrl.trim()) && <span className="font-normal text-ink-faint"> · {baseBranch}</span>}
              </PickerButton>
            }
            className="w-[360px]"
          >
            {place === "local" ? (
              <div className="p-1">
                {prefs.recentProjects.length > 0 && (
                  <>
                    <p className="px-2.5 pt-1.5 pb-1 text-[12.5px] font-medium text-ink-faint">Recent projects</p>
                    {prefs.recentProjects.map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          void pickProject(p);
                          setProjectOpen(false);
                        }}
                        className={cx(
                          "flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left hover:bg-cream-deep",
                          p === repoPath && "bg-cream-deep",
                        )}
                      >
                        <FolderOpen aria-hidden="true" className="size-4 text-ink-faint" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px]">{repoName(p)}</span>
                          <span className="block truncate font-mono text-[12px] text-ink-faint">{p}</span>
                        </span>
                      </button>
                    ))}
                    <div className="mx-1 my-1 h-px bg-line" />
                  </>
                )}
                <button
                  type="button"
                  disabled={!shell}
                  onClick={() => void chooseFolder().then(() => setProjectOpen(false))}
                  className="flex h-9 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[14px] hover:bg-cream-deep disabled:opacity-50"
                >
                  <FolderPlus aria-hidden="true" className="size-4 text-ink-faint" />
                  {shell ? "Choose a folder…" : "Choosing folders needs the desktop app"}
                </button>
                <div className="border-t border-line px-2.5 pt-2.5 pb-2">
                  <BranchField value={baseBranch} onChange={setBaseBranch} />
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-3">
                <label className="block">
                  <span className="mb-1 block text-[13.5px] font-medium">Repository</span>
                  <TextInput
                    value={repoUrl}
                    onChange={e => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/you/app.git"
                    className="font-mono text-[13px]"
                    autoFocus
                  />
                </label>
                <BranchField value={baseBranch} onChange={setBaseBranch} />
                <div>
                  <span className="mb-1 block text-[13.5px] font-medium">Sandbox size</span>
                  <SegmentedControl
                    label="Sandbox size"
                    value={sandboxSize}
                    onChange={setSandboxSize}
                    options={(["small", "large"] as const).map(s => ({
                      value: s,
                      label: `${s === "small" ? "Small" : "Large"}: ${SANDBOX_RESOURCES[s].vcpu} CPU, ${SANDBOX_RESOURCES[s].memoryGiB} GB`,
                    }))}
                  />
                </div>
              </div>
            )}
          </Popover>

          <Menu
            trigger={
              <PickerButton icon={place === "cloud" ? <Cloud className="text-leaf" /> : <Laptop />}>
                {place === "cloud" ? "Cloud" : "This computer"}
              </PickerButton>
            }
          >
            <MenuChoice
              value={place}
              onChange={v => (v === "cloud" && !cloudAvailable ? onConnectCloud() : onPrefs({ lastPlace: v }))}
              options={[
                { value: "local", label: "This computer", icon: <Laptop /> },
                { value: "cloud", label: cloudAvailable ? "Cloud" : "Cloud (connect an account)", icon: <Cloud /> },
              ]}
            />
            {!cloudAvailable && (
              <>
                <MenuSeparator />
                <MenuItem icon={<ExternalLink />} onSelect={onConnectCloud}>
                  Connect a cloud account
                </MenuItem>
              </>
            )}
          </Menu>
        </div>

        {(error || denial) && (
          <div
            role="alert"
            className={cx(
              "mt-4 flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[14px]",
              denial ? "border-[#f0d95c] bg-lemon-soft" : "border-danger/25 bg-danger-soft text-danger",
            )}
          >
            <p className="min-w-0 flex-1">{denial?.reason ?? error}</p>
            {denial?.actionUrl && (
              <Button size="sm" variant="primary" onClick={() => void openExternal(denial.actionUrl!)}>
                {denial.actionLabel ?? "Continue"}
              </Button>
            )}
          </div>
        )}

        {threadCount < 10 && (
          <>
            <div className="mt-10 flex items-center gap-3 text-[13px] text-ink-faint" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              One-click prompts
              <span className="h-px flex-1 bg-line" />
            </div>
            <ul className="mt-4 flex flex-wrap justify-center gap-2.5" aria-label="One-click prompts">
              {STARTERS.map(s => (
                <li key={s.label}>
                  <button
                    type="button"
                    onClick={() => composer.current?.fill(s.prompt)}
                    className="h-8 rounded-full bg-cream-deep px-4 text-[14px] text-ink transition-colors duration-100 hover:bg-cream-hover"
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="mt-6 flex items-center gap-2 px-2 text-[14px] text-ink-soft">
          <Zap aria-hidden="true" className="size-4 shrink-0 text-leaf" />
          {cloudAvailable ? (
            <span>Messages you send while the agent works wait in a queue, and run as soon as it's free.</span>
          ) : (
            <span>
              Run agents in the cloud and they keep working after you close your laptop.{" "}
              <button type="button" onClick={onConnectCloud} className="font-semibold text-leaf hover:text-leaf-deep">
                Connect →
              </button>
            </span>
          )}
        </p>
      </div>
    </main>
  );
}

function BranchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13.5px] font-medium">Start from branch</span>
      <TextInput value={value} onChange={e => onChange(e.target.value)} placeholder="main" className="font-mono text-[13px]" spellCheck={false} />
    </label>
  );
}
