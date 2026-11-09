import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  BookOpen,
  Check,
  Cloud,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Laptop,
  ListChecks,
  Paperclip,
  Plus,
  Server,
  X,
  Zap,
} from "lucide-react";
import {
  AGENT_CAPABILITIES,
  SANDBOX_RESOURCES,
  type AgentKind,
  type PermissionMode,
  type PolicyDenied,
  type PullRequestLookup,
  type SandboxSize,
} from "@lemonlime/protocol";
import { existingBranchProblem, pullRequestIn } from "../lib/branches.ts";
import { splitCommand } from "../lib/command.ts";
import { repoName } from "../lib/format.ts";
import { effortLevels, pickerAgents } from "../lib/models.ts";
import { keysFor } from "../lib/shortcuts.ts";
import type { AgentInstall } from "../lib/system.ts";
import { inDesktopShell, inspectRepo, listSkills, lookupPullRequest, pickFolder, type SkillInfo } from "../lib/native.ts";
import { StartBranch, useBranches, type StartMode } from "./StartBranch.tsx";
import { attachmentProblem } from "../lib/useAttachments.ts";
import { attachmentLabel, pastedTextFile } from "../lib/pastedText.ts";
import { PermissionPicker } from "./AgentLoop.tsx";
import { DeniedError, type NewThreadInput } from "../lib/newThread.ts";
import { showGetStarted, type GetStartedFacts, type GetStartedStep } from "../lib/getStarted.ts";
import { otherProjectMentioned } from "../lib/projectHint.ts";
import { rememberPath, remoteFolderName, remotePathProblem, saveMachines, useMachines } from "../lib/machines.ts";
import { GetStarted } from "./GetStarted.tsx";
import type { Settings, UiPrefs } from "../lib/storage.ts";
import { Composer, PickerButton, type ComposerHandle } from "./Composer.tsx";
import { defaultModel, ModelControl } from "./ModelControl.tsx";
import { Menu, MenuChoice, MenuItem, MenuLabel, MenuSeparator, Popover, SubMenu } from "./primitives.tsx";
import { Button, SegmentedControl, TextInput, cx, openExternal } from "./ui.tsx";

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

/** Text to put in the composer, and (for a new thread in a project, or a fork) the project to start in. */
export interface HomeDraft {
  text: string;
  nonce: number;
  project?: { mode: "local"; path: string } | { mode: "cloud"; url: string };
  /** A fork from the thread menu: the new thread starts with this branch's code. */
  startFrom?: string;
}

export interface HomeProps {
  cloudAvailable: boolean;
  threadCount: number;
  prefs: UiPrefs;
  onPrefs: (patch: Partial<UiPrefs>) => void;
  onCreate: (input: NewThreadInput) => Promise<void>;
  onConnectCloud: () => void;
  /** The LemonLime dashboard, when connected (for GitHub setup). */
  dashboardUrl?: string;
  /** Text to put in the composer (from Skills, Plugins…); a new nonce fills it again. */
  draft?: HomeDraft | null;
  /** ACP agents saved in Settings. */
  acpAgents?: Settings["acpAgents"];
  /** Agent CLIs found on this computer (null while looking), for the model picker's tabs. */
  agents?: AgentInstall[] | null;
  /** What the Get started checklist needs to know (everything but the projects and dismissal, which are prefs). */
  getStarted?: Omit<GetStartedFacts, "projects" | "dismissed">;
  onOpenSettings?: (page: string) => void;
  /** Path to lemonlime-runner (Settings), for listing branches and finding pull requests. */
  runnerPath?: string;
}

/**
 * The home screen is the composer: write what you want, pick the project and where it
 * runs underneath, send. Sending starts a thread.
 */
export function Home({
  cloudAvailable,
  threadCount,
  prefs,
  onPrefs,
  onCreate,
  onConnectCloud,
  draft,
  acpAgents = [],
  agents = null,
  getStarted,
  onOpenSettings,
  dashboardUrl,
  runnerPath,
}: HomeProps) {
  const composer = useRef<ComposerHandle>(null);
  const shell = inDesktopShell();
  const machines = useMachines();
  // What was picked in the place menu here, over the default from Settings.
  const [picked, setPicked] = useState<string | null>(null);
  const fromPrefs =
    prefs.defaultPlace === "last" ? (prefs.lastPlace === "local" && prefs.lastMachine ? `machine:${prefs.lastMachine}` : prefs.lastPlace) : prefs.defaultPlace;
  const wanted = picked ?? fromPrefs;
  const place = wanted === "cloud" && cloudAvailable ? "cloud" : "local";
  // One of the user's machines over SSH (Settings → Machines): a local thread whose folder is there.
  const machine = place === "local" && wanted.startsWith("machine:") ? machines.find(m => `machine:${m.id}` === wanted) : undefined;
  const placeValue = place === "cloud" ? "cloud" : machine ? `machine:${machine.id}` : "local";
  const [remotePath, setRemotePath] = useState(() => machine?.recentPaths[0] ?? "");
  useEffect(() => {
    if (draft && (draft.text || !draft.project)) composer.current?.fill(draft.text);
    if (draft) setForkFrom(draft.startFrom ?? null);
    if (draft?.project?.mode === "local") {
      setPicked("local");
      void pickProject(draft.project.path);
    } else if (draft?.project?.mode === "cloud") {
      setPicked("cloud");
      setRepoUrl(draft.project.url);
    }
    if (draft) composer.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const agent = prefs.lastAgent;
  const caps = AGENT_CAPABILITIES[agent];
  // The model, effort and fast mode last picked for each agent; the first listed model otherwise.
  const choiceOf = (k: AgentKind) => prefs.agentChoices[k] ?? { model: null, reasoning: null, fast: false };
  const choice = choiceOf(agent);
  const model = choice.model ?? defaultModel(agent);
  const levels = effortLevels(agent, prefs.showMaxReasoning);
  const reasoning = choice.reasoning && levels.includes(choice.reasoning) ? choice.reasoning : null;
  const fast = caps.fast && choice.fast;
  const choose = (k: AgentKind, patch: Partial<ReturnType<typeof choiceOf>>) =>
    onPrefs({ lastAgent: k, agentChoices: { ...prefs.agentChoices, [k]: { ...choiceOf(k), ...patch } } });
  const acpSaved = acpAgents.find(a => a.id === prefs.lastAcpAgent) ?? acpAgents[0];
  const acpCommand = acpSaved?.command ?? "";
  const tabs = pickerAgents({
    order: prefs.agentOrder,
    hidden: prefs.hiddenAgents,
    installed: agents,
    inShell: shell,
    acpSaved: acpAgents.length,
    current: agent,
  });
  const [repoPath, setRepoPath] = useState(prefs.recentProjects[0] ?? "");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  // Make a new branch from baseBranch, or work on baseBranch itself.
  const [startMode, setStartMode] = useState<StartMode>("new");
  // A fork from the thread menu starts with the earlier thread's code.
  const [forkFrom, setForkFrom] = useState<string | null>(null);
  const [sandboxSize, setSandboxSize] = useState<SandboxSize>("small");
  const [projectOpen, setProjectOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denial, setDenial] = useState<PolicyDenied | null>(null);
  const [typed, setTyped] = useState("");
  const [hintDismissed, setHintDismissed] = useState<string | null>(null);
  // Files for the first message: kept here until the thread's runner is up, then uploaded.
  const [files, setFiles] = useState<{ id: string; file: File; problem: string | null }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (list: File[]) => setFiles(cur => [...cur, ...list.map(file => ({ id: crypto.randomUUID(), file, problem: attachmentProblem(file) }))]);
  // What the agent may do without asking; null is the usual for where it runs.
  const usualPermission: PermissionMode = place === "cloud" ? "full" : "edits";
  const [permissionPick, setPermissionPick] = useState<PermissionMode | null>(null);
  const permission = permissionPick && caps.permissions.includes(permissionPick) ? permissionPick : usualPermission;
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const loadSkills = () => {
    if (skills === null) void listSkills().then(setSkills, () => setSkills([]));
  };
  const canPickBranch = place === "local" && !machine && shell;
  const { branches, failed: branchesFailed } = useBranches(canPickBranch ? repoPath : "", runnerPath);
  // A pull request link (or #123) in the message or the branch field: the thread can work on its branch.
  const prSource = canPickBranch && repoPath ? (pullRequestIn(baseBranch) ?? pullRequestIn(typed)) : null;
  const [pr, setPr] = useState<{ ref: string; lookup?: PullRequestLookup; error?: string } | null>(null);
  const [prDismissed, setPrDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!prSource || prSource === prDismissed) return setPr(null);
    if (pr?.ref === prSource) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setPr({ ref: prSource });
      lookupPullRequest(repoPath, prSource, runnerPath)
        .then(lookup => !cancelled && setPr({ ref: prSource, lookup }))
        .catch(err => !cancelled && setPr({ ref: prSource, error: err instanceof Error ? err.message : String(err) }));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `pr` is read only to skip a lookup already done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prSource, prDismissed, repoPath, runnerPath]);
  const prChosen = pr?.lookup ?? null;
  const hinted = prefs.projectHint && place === "local" && !machine ? otherProjectMentioned(typed, prefs.recentProjects, repoPath) : null;
  const projectHint = hinted && hinted !== hintDismissed ? hinted : null;

  const pickProject = async (path: string) => {
    setError(null);
    if (path !== repoPath) setForkFrom(null);
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

  /** Starts the thread; false (the message stays in the box) when something is missing first. */
  const send = (prompt: string): boolean => {
    setError(null);
    setDenial(null);
    const stop = (message: string, openProject = false) => {
      if (openProject) setProjectOpen(true);
      setError(message);
      return false;
    };
    const words = agent === "acp" ? splitCommand(acpCommand) : [];
    if (agent === "acp" && words.length === 0) return stop("Pick an ACP agent in the model picker, or add one in Settings, Agents, ACP agents.");
    const remote = remotePath.trim();
    if (machine) {
      const problem = remotePathProblem(remote, "project folder");
      if (problem) return stop(problem, true);
    } else if (place === "local" && !repoPath) {
      return stop("Choose the project folder the agent should work in.", true);
    }
    if (place === "cloud" && !repoUrl.trim()) return stop("Enter the repository the cloud agent should clone.", true);
    if (pr && !prChosen) return stop(pr.error ?? "Still looking up the pull request. Send again in a moment.");
    if (!prChosen && !baseBranch.trim()) return stop("Enter the branch the agent should start from.");
    const existing = canPickBranch && !prChosen && !forkFrom && startMode === "existing";
    if (existing) {
      const problem = existingBranchProblem(branches, baseBranch, repoPath);
      if (problem) return stop(problem, true);
    }
    void create(prompt, words, remote, existing);
    return true;
  };
  const create = async (prompt: string, words: string[], remote: string, existing: boolean) => {
    const sending = files.filter(f => !f.problem).map(f => f.file);
    const common = {
      title: "",
      agent,
      agentCommand: agent === "acp" ? words : undefined,
      model: agent === "acp" ? undefined : (model ?? undefined),
      reasoning: reasoning ?? undefined,
      fast: fast || undefined,
      baseBranch: prChosen ? prChosen.baseBranch : baseBranch.trim(),
      prompt,
      ...(sending.length ? { attachments: sending } : {}),
      ...(permission !== usualPermission ? { permission } : {}),
    };
    setBusy(true);
    try {
      if (machine) {
        await onCreate({ mode: "local", ...common, repoPath: remote, machine: machine.id });
        saveMachines(rememberPath(machines, machine.id, remote));
      } else {
        const start = prChosen
          ? { existingBranch: { name: prChosen.localBranch, pullRequest: { number: prChosen.number, url: prChosen.url, title: prChosen.title } } }
          : existing
            ? { existingBranch: { name: baseBranch.trim() } }
            : forkFrom
              ? { startFrom: forkFrom }
              : {};
        await onCreate(
          place === "local" ? { mode: "local", ...common, repoPath, ...start } : { mode: "cloud", ...common, repoUrl: repoUrl.trim(), sandboxSize },
        );
      }
      setFiles([]);
      setForkFrom(null);
      setStartMode("new");
      setPermissionPick(null);
    } catch (err) {
      if (err instanceof DeniedError) setDenial(err.denial);
      else setError(err instanceof Error ? err.message : String(err));
      composer.current?.fill(prompt);
    } finally {
      setBusy(false);
    }
  };

  const checklist: GetStartedFacts | null = getStarted ? { ...getStarted, projects: prefs.recentProjects.length, dismissed: prefs.getStartedDismissed } : null;
  const onStep = (id: GetStartedStep) => {
    if (id === "agent") return onOpenSettings?.("agents");
    if (id === "project") return void chooseFolder();
    if (id === "thread") return composer.current?.focus();
    if (id === "cloud") {
      if (!cloudAvailable) return onConnectCloud();
      setPicked("cloud");
      onPrefs({ lastPlace: "cloud" });
      setProjectOpen(true);
      return;
    }
    if (!cloudAvailable) return onConnectCloud();
    if (dashboardUrl) void openExternal(`${dashboardUrl.replace(/\/+$/, "")}/settings#github`);
  };

  const projectLabel = machine
    ? remotePath.trim()
      ? remoteFolderName(remotePath.trim())
      : `Choose a project on ${machine.name}`
    : place === "local"
      ? repoPath
        ? repoName(repoPath)
        : "Work in a project"
      : repoUrl.trim()
        ? repoName(repoUrl)
        : "Choose a repository";
  const projectChosen = machine ? remotePath.trim() : place === "local" ? repoPath : repoUrl.trim();

  return (
    <main className="scroll-thin @container/home min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[740px] px-6 pt-[14vh] pb-16 @max-[480px]/home:px-3">
        <h1 className="mb-6 text-center font-display text-[30px] font-semibold tracking-[-0.03em] text-balance text-ink @max-[480px]/home:text-[22px]">
          What should your agent work on?
        </h1>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={e => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        {files.length > 0 && (
          <ul aria-label="Files to send with your message" className="mb-2 flex flex-wrap gap-1.5">
            {files.map(f => (
              <li
                key={f.id}
                title={f.problem ?? `${f.file.name}. It's uploaded once the thread starts.`}
                className={cx(
                  "inline-flex h-8 max-w-[260px] items-center gap-2 rounded-lg border bg-paper pr-1 pl-2.5 text-[13px]",
                  f.problem ? "border-danger/30 text-danger" : "border-line-strong text-ink",
                )}
              >
                <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 truncate">{attachmentLabel(f.file.name)}</span>
                {f.problem && <span className="shrink-0 text-[12px]">Too big</span>}
                <button
                  type="button"
                  aria-label={`Remove ${f.file.name}`}
                  onClick={() => setFiles(cur => cur.filter(x => x.id !== f.id))}
                  className="inline-flex size-6 items-center justify-center rounded-md text-ink-faint hover:bg-cream-deep hover:text-ink"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Files dropped or pasted here go with the first message, like the paperclip in a thread. */}
        {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- drop and paste targets; the "+" menu is the keyboard way */}
        <div
          onDragOver={e => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={e => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            addFiles([...e.dataTransfer.files]);
          }}
          onPaste={e => {
            const pasted = [...e.clipboardData.files];
            if (!pasted.length) return;
            e.preventDefault();
            addFiles(pasted);
          }}
        >
          <Composer
            ref={composer}
            autoFocus
            busy={busy}
            onSend={send}
            onLongPaste={pasted => {
              addFiles([
                pastedTextFile(
                  pasted,
                  files.map(f => f.file.name),
                ),
              ]);
              return true;
            }}
            onTextChange={setTyped}
            tools={
              <>
                <Menu
                  trigger={
                    <button
                      type="button"
                      aria-label="Add files, a skill or plan mode"
                      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink data-[popup-open]:bg-cream-deep"
                      onPointerEnter={loadSkills}
                      onFocus={loadSkills}
                    >
                      <Plus aria-hidden="true" className="size-[18px]" />
                    </button>
                  }
                >
                  <MenuItem icon={<Paperclip />} onSelect={() => fileInput.current?.click()}>
                    Attach files…
                  </MenuItem>
                  <SubMenu icon={<BookOpen />} label="Use a skill">
                    {skills === null ? (
                      <MenuLabel>Looking for skills…</MenuLabel>
                    ) : skills.length === 0 ? (
                      <MenuLabel>{shell ? "No skills yet. Add them on the Skills page." : "Skills are listed in the desktop app."}</MenuLabel>
                    ) : (
                      <div className="scroll-thin max-h-[280px] overflow-y-auto">
                        {skills.map(k => (
                          <MenuItem key={`${k.source}:${k.name}`} onSelect={() => composer.current?.fill(`/${k.name} ${typed.replace(/^\/\S+\s*/, "")}`)}>
                            <span title={k.description || undefined}>{k.name}</span>
                          </MenuItem>
                        ))}
                      </div>
                    )}
                  </SubMenu>
                  {caps.permissions.includes("plan") && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        icon={<ListChecks />}
                        onSelect={() => setPermissionPick(permission === "plan" ? null : "plan")}
                        hint={permission === "plan" ? <Check aria-label="On" className="!text-leaf" /> : undefined}
                      >
                        Plan first
                      </MenuItem>
                    </>
                  )}
                </Menu>
                <ModelControl
                  agent={agent}
                  tabs={tabs}
                  model={model}
                  reasoning={reasoning}
                  fast={fast}
                  levels={levels}
                  acpAgents={acpAgents}
                  acpId={acpSaved?.id ?? null}
                  onModel={(k, m) => (k === "acp" ? onPrefs({ lastAgent: "acp", lastAcpAgent: m ?? "" }) : choose(k, { model: m }))}
                  onReasoning={r => choose(agent, { reasoning: r })}
                  onFast={on => choose(agent, { fast: on })}
                  cycleKeys={keysFor("cycle-effort", prefs.shortcuts)}
                  side="bottom"
                />
              </>
            }
          />
        </div>

        {/* Context row: the project, and where the agent runs. */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1 px-2">
          <Popover
            open={projectOpen}
            onOpenChange={setProjectOpen}
            trigger={
              <PickerButton icon={place === "local" ? <FolderPlus /> : <GitBranch />} tone={projectChosen ? "plain" : "muted"}>
                {projectLabel}
                {projectChosen && (
                  <span className="ml-1 font-normal text-ink-faint">
                    {prChosen
                      ? `on ${prChosen.localBranch}`
                      : forkFrom
                        ? `from ${forkFrom}`
                        : canPickBranch && startMode === "existing"
                          ? `on ${baseBranch}`
                          : `from ${baseBranch}`}
                  </span>
                )}
              </PickerButton>
            }
            className="w-[360px]"
          >
            {machine ? (
              <div className="space-y-3 p-3">
                <label className="block">
                  <span className="mb-1 block text-[14px] font-medium">Project folder on {machine.name}</span>
                  <TextInput
                    value={remotePath}
                    onChange={e => setRemotePath(e.target.value)}
                    placeholder="~/code/my-app"
                    className="font-mono text-[13px]"
                    spellCheck={false}
                    autoFocus
                  />
                  <span className="mt-1 block text-[13px] text-ink-faint">
                    A git repository already on that machine. Folders there can't be browsed from here, so type its path.
                  </span>
                </label>
                {machine.recentPaths.length > 0 && (
                  <div className="-mx-1">
                    {machine.recentPaths.map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setRemotePath(p);
                          setProjectOpen(false);
                        }}
                        className={cx(
                          "flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2 text-left hover:bg-cream-deep",
                          p === remotePath.trim() && "bg-cream-deep",
                        )}
                      >
                        <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-ink-faint" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{p}</span>
                      </button>
                    ))}
                  </div>
                )}
                <BranchField value={baseBranch} onChange={setBaseBranch} />
              </div>
            ) : place === "local" ? (
              <div className="p-1">
                {prefs.recentProjects.length > 0 && (
                  <>
                    <p className="px-2.5 pt-1.5 pb-1 text-[13px] font-medium text-ink-faint">Recent projects</p>
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
                  {canPickBranch ? (
                    <StartBranch
                      repoPath={repoPath}
                      branches={branches}
                      failed={branchesFailed}
                      value={baseBranch}
                      onChange={setBaseBranch}
                      mode={startMode}
                      onMode={setStartMode}
                      forkFrom={forkFrom}
                      onStartFresh={() => setForkFrom(null)}
                    />
                  ) : (
                    <BranchField value={baseBranch} onChange={setBaseBranch} />
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-3">
                <label className="block">
                  <span className="mb-1 block text-[14px] font-medium">Repository</span>
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
                  <span className="mb-1 block text-[14px] font-medium">Sandbox size</span>
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
              <PickerButton icon={place === "cloud" ? <Cloud className="text-leaf" /> : machine ? <Server /> : <Laptop />}>
                {place === "cloud" ? "Cloud" : machine ? machine.name : "This computer"}
              </PickerButton>
            }
          >
            <MenuChoice
              value={placeValue}
              onChange={v => {
                if (v === "cloud" && !cloudAvailable) return onConnectCloud();
                setPicked(v);
                if (v === "cloud") return onPrefs({ lastPlace: "cloud" });
                const id = v.startsWith("machine:") ? v.slice("machine:".length) : "";
                setRemotePath(machines.find(m => m.id === id)?.recentPaths[0] ?? "");
                onPrefs({ lastPlace: "local", lastMachine: id });
              }}
              options={[
                { value: "local", label: "This computer", icon: <Laptop /> },
                ...machines.map(m => ({ value: `machine:${m.id}`, label: m.name, icon: <Server /> })),
                { value: "cloud", label: cloudAvailable ? "Cloud" : "Cloud (connect an account)", icon: <Cloud /> },
              ]}
            />
            {onOpenSettings && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Plus />} onSelect={() => onOpenSettings("machines")}>
                  {machines.length ? "Manage machines" : "Add a machine over SSH"}
                </MenuItem>
              </>
            )}
            {!cloudAvailable && (
              <>
                <MenuSeparator />
                <MenuItem icon={<ExternalLink />} onSelect={onConnectCloud}>
                  Connect a cloud account
                </MenuItem>
              </>
            )}
          </Menu>

          <PermissionPicker
            kind={agent}
            value={permission}
            working={false}
            disabled={false}
            side="bottom"
            onChange={mode => setPermissionPick(mode === usualPermission ? null : mode)}
          />
        </div>

        {pr && (
          <div
            role="status"
            className={cx(
              "mt-2.5 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[14px]",
              pr.error ? "border-line bg-cream-deep" : "border-line-strong bg-paper",
            )}
          >
            <GitPullRequest aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-soft" />
            <div className="min-w-0 flex-1 space-y-0.5">
              {pr.lookup ? (
                <>
                  <p className="font-medium text-pretty">
                    #{pr.lookup.number} {pr.lookup.title}
                  </p>
                  <p className="text-[13px] text-pretty text-ink-soft">
                    {pr.lookup.state === "open" ? (pr.lookup.draft ? "Draft pull request" : "Open pull request") : `This pull request is ${pr.lookup.state}`}{" "}
                    into <span className="font-mono text-[12px]">{pr.lookup.baseBranch}</span>, from{" "}
                    <span className="font-mono text-[12px]">
                      {pr.lookup.fromFork && pr.lookup.headRepo ? `${pr.lookup.headRepo.split("/")[0]}:` : ""}
                      {pr.lookup.headBranch}
                    </span>
                    . The thread works on its branch{pr.lookup.pushProblem ? "." : " and can push fixes to it."}
                  </p>
                  {pr.lookup.pushProblem && <p className="text-[13px] text-pretty text-ink">{pr.lookup.pushProblem}</p>}
                </>
              ) : pr.error ? (
                <p className="text-[13px] text-pretty text-ink-soft">{pr.error}</p>
              ) : (
                <p className="text-[13px] text-ink-soft">Looking up the pull request…</p>
              )}
            </div>
            <button
              type="button"
              aria-label={pr.lookup ? "Don't work on this pull request" : "Dismiss"}
              onClick={() => setPrDismissed(pr.ref)}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-cream-hover hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}

        {projectHint && (
          <div role="status" className="mt-2.5 flex items-center gap-2 rounded-lg border border-line bg-cream-deep px-3 py-2 text-[14px]">
            <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-ink-soft" />
            <p className="min-w-0 flex-1">
              Did you mean <span className="font-medium">{repoName(projectHint)}</span>? This thread would start in{" "}
              {repoPath ? repoName(repoPath) : "no project"}.
            </p>
            <Button size="sm" onClick={() => void pickProject(projectHint)}>
              <ArrowLeftRight aria-hidden="true" className="size-3.5" />
              Switch
            </Button>
            <button
              type="button"
              aria-label="Keep this project"
              onClick={() => setHintDismissed(projectHint)}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-faint hover:bg-cream-hover hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}

        {(error || denial) && (
          <div
            role="alert"
            className={cx(
              "mt-4 flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-[14px]",
              denial ? "border-lemon-line bg-lemon-soft" : "border-danger/25 bg-danger-soft text-danger",
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

        {checklist && showGetStarted(checklist) && <GetStarted facts={checklist} onStep={onStep} onDismiss={() => onPrefs({ getStartedDismissed: true })} />}

        {(threadCount < 10 || prefs.keepStarterPrompts) && (
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
      <span className="mb-1 block text-[14px] font-medium">Start from branch</span>
      <TextInput value={value} onChange={e => onChange(e.target.value)} placeholder="main" className="font-mono text-[13px]" spellCheck={false} />
    </label>
  );
}
