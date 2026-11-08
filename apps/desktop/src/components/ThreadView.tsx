import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpCircle,
  Cloud,
  CloudUpload,
  Ellipsis,
  ExternalLink,
  FileDiff,
  FolderOpen,
  GitBranch,
  Globe,
  KeyRound,
  Laptop,
  MessagesSquare,
  Monitor,
  PanelRight,
  Paperclip,
  Pause,
  Play,
  Power,
  RotateCw,
  Shrink,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import {
  agentLoopState,
  AGENT_CAPABILITIES,
  IMPLEMENT_PLAN_PROMPT,
  modeAfterPlan,
  type PolicyDenied,
  type ThreadOptions,
  type ThreadStatus,
} from "@lemonlime/protocol";
import { fetchAttachmentImage, runnerHttpBase } from "@lemonlime/client";
import { buildTimeline } from "../lib/timeline.ts";
import { useThreadSession, type Connection, type SessionState, type SessionTarget } from "../lib/useThreadSession.ts";
import { useAttachments } from "../lib/useAttachments.ts";
import { useComposerSources } from "../lib/composerData.ts";
import { uniquePrompts } from "../lib/promptHistory.ts";
import { COMPUTER_LEVELS, type ComputerLevel } from "../lib/computer.ts";
import type { ThreadEntry } from "../lib/threads.ts";
import { summarize } from "../lib/threads.ts";
import { AGENT_LABELS, STATUS_LABELS, repoName } from "../lib/format.ts";
import { CloudError, type CloudApi } from "../lib/cloud.ts";
import { confirmAction } from "../lib/native.ts";
import { Timeline } from "./Timeline.tsx";
import { FindBar } from "./FindBar.tsx";
import { SelectionQuote } from "./SelectionQuote.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { SideChatPanel } from "./SideChatPanel.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { SignInPanel } from "./SignInPanel.tsx";
import { DiffView } from "./DiffView.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { GitActionsButton, GitStrip, useGitState } from "./GitActions.tsx";
import { clampPanelWidth, loadPanelWidth, saveDraft, savePanelWidth, THREAD_PANEL } from "../lib/storage.ts";
import { ContextMeter, ModelPicker, PermissionPicker, QuestionCard, TodoCard } from "./AgentLoop.tsx";
import { Menu, MenuChoice, MenuItem, MenuLabel, SubMenu, Tip } from "./primitives.tsx";
import { Button, Spinner, StatusDot, cx, openExternal } from "./ui.tsx";

export interface ThreadViewProps {
  /** What Enter does while the agent works: queue (default) or steer. */
  followUp?: "queue" | "steer";
  /** Fold finished turns into one line each. */
  foldFinished?: boolean;
  /** Called when the agent starts waiting for an approval. */
  onNeedsInput?: (title: string) => void;
  notifyWhenFocused?: boolean;
  /** Opens the thread's folder (local threads) in the editor from Settings. */
  onOpenFolder?: () => void;
  entry: ThreadEntry;
  runnerUp: boolean;
  runnerPath: string;
  cloudApi: CloudApi | null;
  onLocalProgress: (id: string, lastSeq: number) => void;
  onLocalStatus: (id: string, status: ThreadStatus) => void;
  onLocalPromptSent: (id: string) => void;
  onStopLocal: (id: string) => Promise<void>;
  onRemoveLocal: (id: string) => void;
  onCloudRefresh: () => void;
  onRunnersChanged: () => void;
  /** Move this thread to the cloud (local) or to this computer (cloud), one conversation. */
  onMove?: (entry: ThreadEntry, from: Connection, onStep: (text: string) => void) => Promise<void>;
  /** Cloud threads: what the agent may do on this computer. */
  computerLevel: ComputerLevel;
  onComputerLevel: (level: ComputerLevel) => void;
  /** How many answers the agent is waiting for in this thread (for the sidebar and dock badge). */
  onWaiting?: (threadId: string, count: number) => void;
  /**
   * The last seq the user had seen in this thread before opening it, when there was more
   * since; the timeline shows a "New" divider there. Read once, when the thread opens.
   */
  unreadAfterSeq?: number | null;
}

export function ThreadView(props: ThreadViewProps) {
  const { entry, cloudApi } = props;
  if (entry.mode === "cloud" && !cloudApi) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-center text-ink-soft">
        Add your control plane URL and access token in Settings to open cloud threads.
      </div>
    );
  }
  const target: SessionTarget =
    entry.mode === "local" ? { mode: "local", meta: entry.meta, runnerPath: props.runnerPath } : { mode: "cloud", thread: entry.thread, api: cloudApi! };
  return <ThreadSessionView {...props} target={target} />;
}

function ThreadSessionView({
  entry,
  target,
  runnerUp,
  cloudApi,
  onLocalProgress,
  onLocalStatus,
  onLocalPromptSent,
  onStopLocal,
  onRemoveLocal,
  onCloudRefresh,
  onRunnersChanged,
  runnerPath,
  computerLevel,
  onComputerLevel,
  onMove,
  followUp = "queue",
  foldFinished = false,
  onNeedsInput,
  notifyWhenFocused = false,
  onOpenFolder,
  onWaiting,
  unreadAfterSeq,
}: ThreadViewProps & { target: SessionTarget }) {
  // Where the divider goes is decided when the thread opens; reading it marks it seen.
  const [unreadAt] = useState(unreadAfterSeq ?? null);
  const levelRef = useRef(computerLevel);
  levelRef.current = computerLevel;
  const session = useThreadSession(target, {
    computerLevel: () => levelRef.current,
    onProgress: entry.mode === "local" ? onLocalProgress : undefined,
    onStatus: entry.mode === "local" ? onLocalStatus : undefined,
    onPromptSent: onLocalPromptSent,
  });
  const summary = summarize(entry, runnerUp);
  const items = useMemo(() => buildTimeline(session.events, session.pending), [session.events, session.pending]);
  const loadImage = useSentImageLoader(session.connection);
  // The agent is waiting on an approval or a question: tell the person if they aren't looking.
  const waiting = items.filter(i => (i.kind === "approval" || i.kind === "question") && i.state === "waiting").map(i => i.key);
  const told = useRef(new Set<string>());
  const waitingKey = waiting.join(",");
  useEffect(() => {
    for (const key of waiting) {
      if (told.current.has(key)) continue;
      told.current.add(key);
      if (onNeedsInput && (!document.hasFocus() || notifyWhenFocused)) onNeedsInput(summarize(entry, runnerUp).title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey]);
  useEffect(() => {
    onWaiting?.(entry.mode === "local" ? entry.meta.id : entry.thread.id, waiting.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting.length]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [denial, setDenial] = useState<PolicyDenied | null>(null);

  const connected = session.state === "live" || session.state === "reconnecting";
  // While connected the runner is the source of truth; otherwise the control plane (cloud) is.
  const liveStatus: ThreadStatus | null = entry.mode === "cloud" ? (connected ? (session.status ?? entry.thread.status) : entry.thread.status) : session.status;
  const working = liveStatus === "running" && connected;
  // To-dos, an open question, the context meter and the thread's current options.
  const loop = useMemo(() => agentLoopState(session.events), [session.events]);
  const threadOptions: ThreadOptions = session.options ??
    loop.options ?? { model: summary.agent.model ?? null, reasoning: summary.agent.reasoning ?? null, permission: entry.mode === "cloud" ? "full" : "edits" };
  const implementPlan = () => {
    session.setOptions({ permission: modeAfterPlan(threadOptions) });
    session.send(IMPLEMENT_PLAN_PROMPT);
  };
  // The runner says the installed agent is older than the version LemonLime is tested with.
  const outdated = useMemo(() => {
    const e = [...session.events].reverse().find(x => x.type === "notice" && x.code === "agent_older_than_tested");
    if (!e || e.type !== "notice") return null;
    return { message: e.message, command: /`([^`]+)`/.exec(e.message)?.[1] ?? null };
  }, [session.events]);
  const [copiedUpdate, setCopiedUpdate] = useState(false);
  // A paused cloud thread still takes messages: sending one saves it and wakes the sandbox.
  const pausedCloud = entry.mode === "cloud" && entry.thread.status === "paused" && session.state === "offline";
  const composerDisabled = !pausedCloud && (session.state === "starting" || session.state === "offline" || session.state === "error");

  // Once a local runner has been started, refresh the "running" set in the sidebar.
  useEffect(() => {
    if (entry.mode === "local" && session.state === "connecting") onRunnersChanged();
  }, [entry.mode, session.state, onRunnersChanged]);

  // A cloud sandbox that is still starting has no endpoint yet: check again shortly.
  const cloudStatus = entry.mode === "cloud" ? entry.thread.status : null;
  const { state: sessionState, restart: restartSession } = session;
  useEffect(() => {
    if (sessionState !== "offline" || cloudStatus !== "provisioning") return;
    const t = setTimeout(() => {
      onCloudRefresh();
      restartSession();
    }, 3000);
    return () => clearTimeout(t);
  }, [sessionState, cloudStatus, onCloudRefresh, restartSession]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    setDenial(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof CloudError && err.denial) setDenial(err.denial);
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stopLocal = () =>
    run(async () => {
      session.disconnect();
      await onStopLocal(summary.id);
      onRunnersChanged();
    });

  const pauseCloud = () =>
    run(async () => {
      await cloudApi!.pauseThread(summary.id);
      onCloudRefresh();
      session.restart();
    });

  const resumeCloud = () =>
    run(async () => {
      await cloudApi!.resumeThread(summary.id);
      onCloudRefresh();
      session.restart();
    });

  const removeLocal = async () => {
    const ok = await confirmAction(
      `Remove “${summary.title}” from LemonLime? The runner is stopped and the history cached in this app is cleared. Your repository and the ${summary.branch} branch are not touched.`,
    );
    if (ok) onRemoveLocal(summary.id);
  };

  // While the computer is offline, a quiet pill says so instead of error cards.
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  const errorText = online ? (actionError ?? session.error) : null;
  const [panelOpen, setPanelOpen] = useState(false);
  // The side-panel shortcut (handled by the app) toggles it.
  useEffect(() => {
    const toggle = () => setPanelOpen(o => !o);
    window.addEventListener("lemonlime:toggle-panel", toggle);
    return () => window.removeEventListener("lemonlime:toggle-panel", toggle);
  }, []);
  // Find in thread (⌘F, handled by the app): pressing it again focuses the bar.
  const [find, setFind] = useState<number | null>(null);
  useEffect(() => {
    const open = () => setFind(n => (n ?? 0) + 1);
    window.addEventListener("lemonlime:find", open);
    return () => window.removeEventListener("lemonlime:find", open);
  }, []);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  // The cloud agent said it isn't signed in (and the user hasn't finished signing it in since).
  const needsSignIn = useMemo(
    () => session.events.some(e => e.type === "error" && e.code === "auth_required") && session.login.update?.state !== "done",
    [session.events, session.login.update],
  );
  useEffect(() => {
    if (session.login.update) setShowSignIn(true);
  }, [session.login.update]);
  const move = async () => {
    if (!onMove || !session.connection) return;
    const ok = await confirmAction(
      entry.mode === "local"
        ? "Move this thread to the cloud? Its conversation and commits go to a new cloud sandbox, so it keeps working after you close your laptop. This copy is archived."
        : "Move this thread to this computer? You'll pick the repository folder; its conversation and commits come here and the cloud sandbox is paused.",
    );
    if (!ok) return;
    setActionError(null);
    setMoving("Starting…");
    try {
      await onMove(entry, session.connection, setMoving);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoving(null);
    }
  };
  const composerRef = useRef<ComposerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = useAttachments(session.connection);
  const suggestions = useComposerSources(session.connection, summary.agent.kind);
  const composerSuggestions = useMemo(
    () => ({ commands: suggestions.commands, onCommandsOpen: suggestions.refreshCommands, searchFiles: suggestions.searchFiles }),
    [suggestions.commands, suggestions.refreshCommands, suggestions.searchFiles],
  );
  // Earlier prompts, for Up and Down in the composer.
  const prompts = useMemo(() => uniquePrompts(session.events.flatMap(e => (e.type === "user_message" ? [e.text] : []))), [session.events]);
  const sendWithFiles = (text: string) => {
    if (files.uploading) {
      setActionError("Wait for the attached files to finish uploading.");
      composerRef.current?.fill(text);
      return;
    }
    setActionError(null);
    saveDraft(summary.id, "");
    session.send(text, files.ready, { steer: followUp === "steer" && session.status === "running" });
    files.clear();
  };
  const rewindTo = async (seq: number, text: string, restoreFiles: boolean) => {
    const ok = await confirmAction(
      restoreFiles
        ? "Go back to this message and put the files back to how they were then? The agent stops, starts a fresh conversation with a recap, and later changes are set aside (git keeps them under refs/lemonlime/rewind)."
        : "Go back to this message? The agent stops and starts a fresh conversation with a recap. Files stay as they are now.",
    );
    if (!ok) return;
    session.rewind(seq, restoreFiles);
    composerRef.current?.fill(text);
  };
  const [panelTab, setPanelTab] = useState<"changes" | "terminal" | "side" | "browser">("changes");

  // Put text into the message being written (e.g. lines picked in a diff), after what's there.
  // Other parts of the app can do the same with a "lemonlime:composer-insert" event ({ text }).
  const composerWrap = useRef<HTMLDivElement>(null);
  const insertIntoComposer = (text: string) => {
    const handle = composerRef.current as (ComposerHandle & { insert?: (t: string) => void }) | null;
    if (handle?.insert) return handle.insert(text);
    const current = composerWrap.current?.querySelector("textarea")?.value ?? "";
    handle?.fill(current.trim() ? `${current.trimEnd()}\n\n${text}` : text);
  };
  // Unsent text stays with the thread: the composer keeps it (draftKey), and the sidebar marks it.
  const insertRef = useRef(insertIntoComposer);
  insertRef.current = insertIntoComposer;
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text === "string" && text) insertRef.current(text);
    };
    window.addEventListener("lemonlime:composer-insert", onInsert);
    return () => window.removeEventListener("lemonlime:composer-insert", onInsert);
  }, []);

  // The branch as git sees it, refreshed when the agent changes files or a turn ends.
  const fileDiffs = useMemo(() => session.events.filter(e => e.type === "file_diff").length, [session.events]);
  const gitRefresh = `${fileDiffs}:${liveStatus ?? ""}`;
  const git = useGitState({ connection: session.connection, mode: entry.mode, threadId: summary.id, cloudApi, refreshKey: gitRefresh });
  const showChanges = () => {
    setPanelTab("changes");
    setPanelOpen(true);
  };

  return (
    <div className="flex min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={`Thread ${summary.title}`}>
        <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5">
          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5">
            <h1 className="min-w-0 truncate font-sans text-[15px] font-semibold tracking-normal text-ink">{summary.title}</h1>
            <span className="hidden min-w-0 items-center gap-1.5 truncate text-[13.5px] text-ink-faint md:inline-flex" title={summary.repo}>
              {summary.mode === "local" ? (
                <Laptop aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{repoName(summary.repo)}</span>
            </span>
          </div>
          {git.available && (git.status || entry.mode === "cloud") && <GitActionsButton git={git} mode={entry.mode} />}
          {!online ? (
            <span
              role="status"
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-cream-deep px-2.5 text-[12.5px] font-medium text-ink-soft"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-control" />
              Offline
            </span>
          ) : (
            <ConnectionBadge state={session.state} status={liveStatus} />
          )}
          {entry.mode === "local" ? (
            session.state === "offline" || session.state === "error" ? (
              <Button size="sm" variant="ghost" onClick={session.restart} disabled={busy}>
                <Play aria-hidden="true" className="size-3.5" />
                Start
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={stopLocal} disabled={busy || session.state === "starting"}>
                <Power aria-hidden="true" className="size-3.5" />
                Stop
              </Button>
            )
          ) : cloudStatus === "paused" || cloudStatus === "stopped" ? (
            <Button size="sm" variant="ghost" onClick={resumeCloud} disabled={busy}>
              <Play aria-hidden="true" className="size-3.5" />
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={pauseCloud} disabled={busy || cloudStatus === "provisioning" || cloudStatus === "failed"}>
              <Pause aria-hidden="true" className="size-3.5" />
              Pause
            </Button>
          )}
          {(entry.mode === "local" || entry.mode === "cloud" || summary.agent.kind === "claude-code") && (
            <Menu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label="Thread options"
                  className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep data-[popup-open]:bg-cream-deep"
                >
                  <Ellipsis aria-hidden="true" className="size-4" />
                </button>
              }
            >
              {summary.agent.kind === "claude-code" && (
                <MenuItem icon={<Shrink />} disabled={session.state !== "live" || working} onSelect={session.compact}>
                  Compact conversation
                </MenuItem>
              )}
              {onMove && (
                <MenuItem
                  icon={entry.mode === "local" ? <CloudUpload /> : <Laptop />}
                  disabled={!session.connection || working || moving !== null}
                  onSelect={() => void move()}
                >
                  {entry.mode === "local" ? "Move to the cloud" : "Move to this computer"}
                </MenuItem>
              )}
              {entry.mode === "cloud" && (summary.agent.kind === "claude-code" || summary.agent.kind === "codex") && (
                <MenuItem icon={<KeyRound />} disabled={session.state !== "live"} onSelect={() => setShowSignIn(true)}>
                  Sign the agent in…
                </MenuItem>
              )}
              {entry.mode === "cloud" && (
                <SubMenu icon={<Monitor />} label={`This computer: ${COMPUTER_LEVELS.find(l => l.value === computerLevel)?.label ?? "Off"}`}>
                  <MenuLabel>What the agent may do on this computer</MenuLabel>
                  <MenuChoice
                    value={computerLevel}
                    onChange={onComputerLevel}
                    options={COMPUTER_LEVELS.map(l => ({ value: l.value, label: <span title={l.hint}>{l.label}</span> }))}
                  />
                </SubMenu>
              )}
              {entry.mode === "local" && onOpenFolder && (
                <MenuItem icon={<FolderOpen />} onSelect={onOpenFolder}>
                  Open in editor
                </MenuItem>
              )}
              {entry.mode === "local" && (
                <MenuItem icon={<Trash2 />} onSelect={() => void removeLocal()}>
                  Remove thread
                </MenuItem>
              )}
            </Menu>
          )}
          {outdated && (
            <Tip label={outdated.command ? `${outdated.message} Click to copy the command.` : outdated.message} side="bottom">
              <button
                type="button"
                onClick={() => {
                  if (!outdated.command) return;
                  void navigator.clipboard?.writeText(outdated.command);
                  setCopiedUpdate(true);
                  setTimeout(() => setCopiedUpdate(false), 2000);
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[#f0d95c] bg-lemon-soft px-2.5 text-[12.5px] font-medium text-ink hover:bg-lemon"
              >
                <ArrowUpCircle aria-hidden="true" className="size-3.5" />
                {copiedUpdate ? "Copied update command" : `Update ${AGENT_LABELS[summary.agent.kind]}`}
              </button>
            </Tip>
          )}
          <Tip label={panelOpen ? "Hide panel" : "Show changes and terminal"} side="bottom">
            <button
              type="button"
              aria-label={panelOpen ? "Hide panel" : "Show changes and terminal"}
              aria-pressed={panelOpen}
              onClick={() => setPanelOpen(o => !o)}
              className={cx(
                "inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep",
                panelOpen && "bg-cream-deep text-ink",
              )}
            >
              <PanelRight aria-hidden="true" className="size-4" />
            </button>
          </Tip>
        </header>

        {denial && (
          <div className="flex items-center gap-3 border-b border-[#f0d95c] bg-lemon-soft px-6 py-2.5 text-[13.5px] text-ink" role="alert">
            <p className="min-w-0 flex-1">{denial.reason}</p>
            {denial.actionUrl && (
              <Button size="sm" variant="secondary" onClick={() => void openExternal(denial.actionUrl!)}>
                {denial.actionLabel || "Learn more"}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </Button>
            )}
          </div>
        )}

        {moving && (
          <div role="status" className="flex items-center gap-3 border-b border-line bg-lemon-soft px-6 py-2.5 text-[13.5px] text-ink">
            <Spinner />
            <p className="min-w-0 flex-1">{moving}</p>
          </div>
        )}
        {errorText && (
          <div className="flex items-center gap-3 border-b border-danger/20 bg-danger-soft px-6 py-2.5 text-[13.5px]" role="alert">
            <p className="min-w-0 flex-1 text-ink">{errorText}</p>
            {(session.state === "error" || session.state === "offline") && (
              <Button size="sm" variant="secondary" onClick={session.restart}>
                <RotateCw aria-hidden="true" className="size-3.5" />
                Try again
              </Button>
            )}
          </div>
        )}

        {entry.mode === "cloud" &&
          session.state === "live" &&
          (showSignIn || needsSignIn) &&
          (summary.agent.kind === "claude-code" || summary.agent.kind === "codex") && (
            <div className="px-6">
              <SignInPanel agentLabel={AGENT_LABELS[summary.agent.kind]} login={session.login} onClose={() => setShowSignIn(false)} />
            </div>
          )}
        <div ref={timelineRef} className="relative flex min-h-0 flex-1 flex-col">
          <Timeline
            foldFinished={foldFinished}
            items={items}
            working={working}
            unreadAfterSeq={unreadAt}
            loadImage={loadImage}
            empty={<EmptyThread state={session.state} mode={summary.mode} branch={summary.branch} cloudStatus={cloudStatus} />}
            onApprove={session.approve}
            onEditQueued={session.editQueued}
            onRewind={rewindTo}
            onImplementPlan={session.state === "live" ? implementPlan : undefined}
          />
          {find !== null && <FindBar root={timelineRef} version={items} focusNonce={find} onClose={() => setFind(null)} />}
          <SelectionQuote root={timelineRef} onQuote={text => composerRef.current?.quote(text)} />
        </div>

        <div
          className="shrink-0 px-6 pt-2 pb-5"
          onDragOver={e => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={e => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            files.add([...e.dataTransfer.files]);
          }}
          onPaste={e => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) {
              e.preventDefault();
              files.add(pasted);
            }
          }}
        >
          <div ref={composerWrap} className="mx-auto max-w-[760px]">
            {loop.question && (
              <QuestionCard
                key={loop.question.requestId}
                request={loop.question}
                onAnswer={session.state === "live" ? answers => session.answerQuestion(loop.question!.requestId, answers) : undefined}
              />
            )}
            {loop.todos && <TodoCard items={loop.todos} />}
            {git.available && <GitStrip git={git} onOpenChanges={showChanges} />}
            {files.items.length > 0 && (
              <ul aria-label="Attached files" className="mb-2 flex flex-wrap gap-1.5">
                {files.items.map(a => (
                  <li
                    key={a.id}
                    title={a.error ?? a.name}
                    className={cx(
                      "inline-flex h-8 max-w-[260px] items-center gap-2 rounded-lg border bg-paper pr-1 pl-2.5 text-[13px]",
                      a.state === "failed" ? "border-[#f3c4be] text-danger" : "border-line-strong text-ink",
                    )}
                  >
                    <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
                    <span className="min-w-0 truncate">{a.name}</span>
                    <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">
                      {a.state === "uploading" ? `${Math.floor((a.sent / Math.max(1, a.size)) * 100)}%` : a.state === "failed" ? "Failed" : ""}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => files.remove(a.id)}
                      className="inline-flex size-6 items-center justify-center rounded-md text-ink-faint hover:bg-ink/5 hover:text-ink"
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={e => {
                files.add([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Composer
              ref={composerRef}
              onSend={sendWithFiles}
              suggestions={composerSuggestions}
              history={prompts}
              draftKey={summary.id}
              onInterrupt={session.interrupt}
              working={working}
              disabled={composerDisabled}
              tools={
                <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[13.5px] text-ink-soft">
                  <Tip label="Attach files (or drop or paste them)">
                    <button
                      type="button"
                      aria-label="Attach files"
                      disabled={!session.connection}
                      onClick={() => fileInput.current?.click()}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep hover:text-ink disabled:opacity-50"
                    >
                      <Paperclip aria-hidden="true" className="size-4" />
                    </button>
                  </Tip>
                  <ModelPicker
                    kind={summary.agent.kind}
                    options={threadOptions}
                    working={working}
                    disabled={session.state !== "live"}
                    onChange={session.setOptions}
                  />
                  <PermissionPicker
                    kind={summary.agent.kind}
                    value={threadOptions.permission}
                    working={working}
                    disabled={session.state !== "live"}
                    onChange={permission => session.setOptions({ permission })}
                  />
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[12.5px]">
                    <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-leaf" />
                    <span className="truncate">{summary.branch}</span>
                  </span>
                  {loop.usage && (
                    <span className="ml-auto">
                      <ContextMeter
                        usage={loop.usage}
                        canCompact={AGENT_CAPABILITIES[summary.agent.kind].compact}
                        compactDisabled={session.state !== "live" || working}
                        onCompact={session.compact}
                      />
                    </span>
                  )}
                </span>
              }
              disabledReason={
                session.state === "starting"
                  ? summary.mode === "local"
                    ? "Starting the runner…"
                    : "Connecting…"
                  : summary.mode === "cloud" && cloudStatus === "paused"
                    ? "This sandbox is paused. Send a message to wake it."
                    : "Not connected"
              }
            />
          </div>
        </div>
      </section>
      {panelOpen && (
        <SidePanel
          tab={panelTab}
          onTab={setPanelTab}
          session={session}
          mode={entry.mode}
          runnerPath={runnerPath}
          onClose={() => setPanelOpen(false)}
          refreshKey={gitRefresh}
          onAddToChat={text => {
            insertIntoComposer(text);
            composerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** The right panel: the files the agent changed, and the thread's terminal. */
function SidePanel({
  tab,
  onTab,
  session,
  mode,
  runnerPath,
  onClose,
  refreshKey,
  onAddToChat,
}: {
  refreshKey: string;
  onAddToChat: (text: string) => void;
  tab: "changes" | "terminal" | "side" | "browser";
  onTab: (t: "changes" | "terminal" | "side" | "browser") => void;
  session: ReturnType<typeof useThreadSession>;
  mode: "local" | "cloud";
  runnerPath: string;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(() => clampPanelWidth(loadPanelWidth(), window.innerWidth));
  const changed = useMemo(() => new Set(session.events.filter(e => e.type === "file_diff").map(e => (e as { path: string }).path)).size, [session.events]);
  // Mounted once opened, so switching tabs doesn't drop the terminal's screen.
  const [terminalSeen, setTerminalSeen] = useState(tab === "terminal");
  useEffect(() => {
    if (tab === "terminal") setTerminalSeen(true);
  }, [tab]);
  const tabClass = (on: boolean) =>
    cx(
      "inline-flex h-[30px] items-center gap-2 rounded-lg px-2.5 text-[14px] font-medium",
      on ? "bg-cream-deep text-ink" : "text-ink-soft hover:bg-cream-deep/60 hover:text-ink",
    );
  return (
    <aside aria-label="Thread panel" style={{ width }} className="relative flex shrink-0 flex-col border-l border-line bg-cream">
      <PanelResizer width={width} onWidth={setWidth} />
      <div role="tablist" aria-label="Panel" className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-3">
        <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => onTab("changes")} className={tabClass(tab === "changes")}>
          <FileDiff aria-hidden="true" className="size-3.5" />
          Changes
          {changed > 0 && <span className="text-ink-faint tabular-nums">{changed}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "terminal"} onClick={() => onTab("terminal")} className={tabClass(tab === "terminal")}>
          <SquareTerminal aria-hidden="true" className="size-3.5" />
          Terminal
        </button>
        <button type="button" role="tab" aria-selected={tab === "browser"} onClick={() => onTab("browser")} className={tabClass(tab === "browser")}>
          <Globe aria-hidden="true" className="size-3.5" />
          Browser
        </button>
        <button type="button" role="tab" aria-selected={tab === "side"} onClick={() => onTab("side")} className={tabClass(tab === "side")}>
          <MessagesSquare aria-hidden="true" className="size-3.5" />
          Side chat
        </button>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="inline-flex size-8 items-center justify-center rounded-lg text-ink-soft hover:bg-cream-deep"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {tab === "changes" && (
        <ReviewPanel connection={session.connection} refreshKey={refreshKey} onAddToChat={onAddToChat} fallback={<ChangesList events={session.events} />} />
      )}
      {tab === "side" && <SideChatPanel side={session.side} connected={session.state === "live"} />}
      {tab === "browser" && <PreviewPanel events={session.events} mode={mode} connection={session.connection} {...(runnerPath ? { runnerPath } : {})} />}
      {terminalSeen && (
        <div className={cx("min-h-0 flex-1 flex-col", tab === "terminal" ? "flex" : "hidden")}>
          <TerminalPanel connection={session.connection} />
        </div>
      )}
    </aside>
  );
}

/**
 * The panel's left edge: drag to resize (arrow keys too, double-click for the default).
 * The width is remembered on this computer.
 */
function PanelResizer({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const set = (w: number, save: boolean) => {
    const next = clampPanelWidth(w, window.innerWidth);
    onWidth(next);
    if (save) savePanelWidth(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={width}
      aria-valuemin={THREAD_PANEL.min}
      aria-valuemax={THREAD_PANEL.max}
      tabIndex={0}
      onPointerDown={e => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
      }}
      onPointerMove={e => {
        if (drag.current) set(drag.current.w + (drag.current.x - e.clientX), false);
      }}
      onPointerUp={e => {
        if (drag.current) set(drag.current.w + (drag.current.x - e.clientX), true);
        drag.current = null;
      }}
      onDoubleClick={() => set(THREAD_PANEL.default, true)}
      onKeyDown={e => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") set(width + step, true);
        else if (e.key === "ArrowRight") set(width - step, true);
        else return;
        e.preventDefault();
      }}
      className="absolute inset-y-0 -left-[3px] z-20 w-[6px] cursor-col-resize outline-none hover:bg-line-strong/60 focus-visible:bg-leaf/40 active:bg-line-strong"
    />
  );
}

/** Every file the agent changed in this thread, latest diff first. */
function ChangesList({ events }: { events: ReturnType<typeof useThreadSession>["events"] }) {
  const files = useMemo(() => {
    const latest = new Map<string, Extract<(typeof events)[number], { type: "file_diff" }>>();
    for (const e of events) if (e.type === "file_diff") latest.set(e.path, e);
    return [...latest.values()].reverse();
  }, [events]);
  const [open, setOpen] = useState<string | null>(null);
  const shown = files.find(f => f.path === open);
  return (
    <div role="tabpanel" aria-label="Changes" className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-ink-soft">
            Files the agent changes show up here after each turn.
          </p>
        ) : shown ? (
          <div>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="mb-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13.5px] text-ink-soft hover:bg-cream-deep"
            >
              ← All files
            </button>
            <DiffView path={shown.path} change={shown.change} diff={shown.diff} truncated={shown.truncated} />
          </div>
        ) : (
          <ul className="flex flex-col gap-px">
            {files.map(f => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setOpen(f.path)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-cream-deep"
                >
                  <span
                    className={cx("size-1.5 shrink-0 rounded-full", f.change === "added" ? "bg-lime-2" : f.change === "deleted" ? "bg-danger" : "bg-lemon-2")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{f.path}</span>
                  <span className="shrink-0 text-[12.5px] text-ink-faint">{f.change}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyThread({ state, mode, branch, cloudStatus }: { state: SessionState; mode: "local" | "cloud"; branch: string; cloudStatus: ThreadStatus | null }) {
  let heading = "Tell the agent what to work on";
  let body = (
    <>
      Everything it changes lands on <span className="font-mono text-[12.5px] text-ink">{branch}</span>, so your other branches stay as they are.
    </>
  );
  if (state === "starting") {
    heading = mode === "local" ? "Starting the runner" : "Connecting";
    body = <>This takes a moment the first time.</>;
  } else if (state === "offline" && cloudStatus === "provisioning") {
    heading = "Starting the sandbox";
    body = <>The thread opens as soon as its sandbox is ready.</>;
  } else if (state === "offline" && cloudStatus === "paused") {
    heading = "This sandbox is paused";
    body = <>Resume it to pick up where the agent left off.</>;
  }
  return (
    <div className="mx-auto mt-[12vh] flex max-w-md flex-col items-center text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-line bg-paper shadow-panel">
        <GitBranch aria-hidden="true" className="size-5 text-leaf" />
      </div>
      <h2 className="text-lg font-semibold text-ink">{heading}</h2>
      <p className="mt-1.5 text-[13.5px] text-ink-soft">{body}</p>
    </div>
  );
}

const STATE_LABEL: Record<SessionState, string> = {
  starting: "Starting",
  connecting: "Connecting",
  live: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  error: "Not connected",
};

function ConnectionBadge({ state, status }: { state: SessionState; status: ThreadStatus | null }) {
  const offlineStatus = state === "offline" && (status === "paused" || status === "provisioning" || status === "failed");
  const label = (state === "live" || offlineStatus) && status ? STATUS_LABELS[status] : STATE_LABEL[state];
  const dot =
    state === "live" ? (
      <StatusDot status={status ?? "idle"} />
    ) : state === "error" ? (
      <StatusDot status="failed" />
    ) : state === "offline" ? (
      <StatusDot status="offline" />
    ) : (
      <span className="inline-block size-2 animate-pulse-soft rounded-full bg-lemon" aria-hidden="true" />
    );
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[13px]",
        state === "error" ? "border-danger/25 bg-danger-soft text-danger" : "border-line bg-paper text-ink-soft",
      )}
      role="status"
      aria-live="polite"
      title={`Connection: ${STATE_LABEL[state]}`}
    >
      {dot}
      {label}
    </span>
  );
}

/**
 * Loads images sent in this thread from its runner, while connected. Each image is fetched
 * once and kept as an object URL until the thread closes.
 */
function useSentImageLoader(connection: Connection | null): ((id: string) => Promise<string>) | null {
  const cache = useRef(new Map<string, Promise<string>>());
  useEffect(() => {
    const kept = cache.current;
    return () => {
      for (const url of kept.values()) url.then(u => URL.revokeObjectURL(u)).catch(() => undefined);
      kept.clear();
    };
  }, []);
  return useMemo(() => {
    if (!connection) return null;
    const base = runnerHttpBase(connection.url);
    return (id: string) => {
      const key = `${base}|${id}`;
      let url = cache.current.get(key);
      if (!url) {
        url = fetchAttachmentImage({ base, token: connection.token, id }).then(blob => URL.createObjectURL(blob));
        url.catch(() => cache.current.delete(key));
        cache.current.set(key, url);
      }
      return url;
    };
  }, [connection]);
}
