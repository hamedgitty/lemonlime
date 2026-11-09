import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpCircle,
  Cloud,
  Ellipsis,
  ExternalLink,
  GitBranch,
  KeyRound,
  Laptop,
  Monitor,
  PanelRight,
  Paperclip,
  Pause,
  Play,
  Power,
  RotateCw,
  Server,
  X,
} from "lucide-react";
import { useMachines } from "../lib/machines.ts";
import {
  agentLoopState,
  backgroundWork,
  childrenSettled,
  AGENT_CAPABILITIES,
  DEFAULT_ACCOUNT_ID,
  IMPLEMENT_PLAN_PROMPT,
  modeAfterPlan,
  type ChildWork,
  type AccountsList,
  type AgentKind,
  type PolicyDenied,
  type ThreadOptions,
  type ThreadStatus,
} from "@lemonlime/protocol";
import { fetchAttachmentImage, runnerHttpBase } from "@lemonlime/client";
import { buildTimeline, waitingOnYou, withoutQueued, type TimelineItem } from "../lib/timeline.ts";
import { latestSubagents } from "../lib/steps.ts";
import { editSendPlan, forkNote, forkTitle, rewindLanded, startEdit, type EditDraft } from "../lib/messageActions.ts";
import { useThreadSession, type Connection, type SessionState, type SessionTarget } from "../lib/useThreadSession.ts";
import { useAttachments } from "../lib/useAttachments.ts";
import { sendBlocker } from "../lib/composerSend.ts";
import { attachmentLabel, pastedTextFile } from "../lib/pastedText.ts";
import { FileLinksContext, type FileLinks } from "../lib/markdown.tsx";
import { focusFacts, pasteGoesToComposer, typingGoesToComposer } from "../lib/typeAnywhere.ts";
import { useComposerSources } from "../lib/composerData.ts";
import { uniquePrompts } from "../lib/promptHistory.ts";
import { COMPUTER_LEVELS, type ComputerLevel } from "../lib/computer.ts";
import type { ThreadEntry } from "../lib/threads.ts";
import { summarize } from "../lib/threads.ts";
import { AGENT_LABELS, STATUS_LABELS, repoName } from "../lib/format.ts";
import { CloudError, type CloudApi } from "../lib/cloud.ts";
import { confirmAction } from "../lib/native.ts";
import { Timeline } from "./Timeline.tsx";
import type { LimitActions } from "./LimitRow.tsx";
import { limitChoices, listAccounts, threadsOnSameLimit } from "../lib/accounts.ts";
import { localRunnerStatuses, type AgentInstall } from "../lib/system.ts";
import { FindBar } from "./FindBar.tsx";
import { SelectionQuote } from "./SelectionQuote.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { SignInPanel } from "./SignInPanel.tsx";
import { ThreadPanel } from "./ThreadPanel.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { BackgroundWorkCard, type HeldMessage } from "./BackgroundWork.tsx";
import { ApprovalCard, EditingCard, QueuedCard } from "./WaitingStack.tsx";
import { GitActionsButton, GitStrip, useGitState } from "./GitActions.tsx";
import { suggestNextPrompt } from "../lib/nextPrompt.ts";
import { saveDraft } from "../lib/storage.ts";
import { loadPanelState, openFile, reopenTab, savePanelState, type PanelState } from "../lib/panel.ts";
import { keysFor } from "../lib/shortcuts.ts";
import { betterTitle } from "../lib/threadTitle.ts";
import { ContextMeter, ModelPicker, PermissionPicker, QuestionCard, TodoCard } from "./AgentLoop.tsx";
import { MenuChoice, MenuItem, MenuLabel, SubMenu, Tip } from "./primitives.tsx";
import { RenameField, ThreadMenu, type AppThreadMenu, type ThreadMenuHandlers } from "./ThreadMenu.tsx";
import { childRowKey, REVEAL_CHILD_EVENT, rememberPullRequest, removeThreadText, takeRevealChild } from "../lib/threadMenu.ts";
import { flashItem } from "../lib/findInThread.ts";
import { Button, Spinner, StatusDot, cx, openExternal } from "./ui.tsx";
import { PaneButton, PaneHeader, type PaneControls } from "./SplitView.tsx";

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
  /** Split view: whether this pane has the keyboard (shortcuts, find, inserted text). Default true. */
  active?: boolean;
  /** A new number moves the keyboard to the composer. */
  focusNonce?: number;
  /** Split view: a slim header with the pane's maximise and close buttons. */
  paneControls?: PaneControls;
  /** Split view: the pane's width in pixels, so the side panel fits inside it. */
  room?: number;
  /**
   * The last seq the user had seen in this thread before opening it, when there was more
   * since; the timeline shows a "New" divider there. Read once, when the thread opens.
   */
  unreadAfterSeq?: number | null;
  /** Offer a likely next message in the empty composer once a turn ends. */
  suggestNext?: boolean;
  /** The subagents working for this thread right now (for the sidebar). */
  onChildren?: (threadId: string, children: ChildWork[]) => void;
  /** Shortcuts the user changed (for menu hints). */
  shortcuts?: Record<string, string>;
  /** The agents on this computer (for carrying a thread on past a usage limit). */
  agents?: AgentInstall[] | null;
  /** A local thread moved to another agent. */
  onLocalAgent?: (id: string, agent: { kind: AgentKind; model?: string | undefined }) => void;
  /** A better title, when the thread's is still the vague one made from its first message. */
  onAutoTitle?: (title: string) => void;
  /** Switch these other local threads to an account too (they stopped on the same limit). */
  onSwitchOthers?: (threadIds: string[], accountId: string) => Promise<number>;
  /** The thread menu's items the app handles (pin, unread, split, fork, archive, rename). */
  threadMenu?: AppThreadMenu;
  /** Start a new thread on the same project from a note of this conversation. */
  onFork?: (entry: ThreadEntry, note: string, title: string) => Promise<void>;
}

/** Below this width a pane's side panel lies over the conversation, and only in the active pane. */
const NARROW_PANE_PX = 680;

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
  active = true,
  focusNonce = 0,
  paneControls,
  room,
  unreadAfterSeq,
  suggestNext = true,
  onChildren,
  shortcuts = {},
  agents,
  onLocalAgent,
  onAutoTitle,
  onSwitchOthers,
  threadMenu,
  onFork,
}: ThreadViewProps & { target: SessionTarget }) {
  const activeRef = useRef(active);
  activeRef.current = active;
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
  // A thread on another machine (over SSH): its name stands where "this computer" would.
  const machines = useMachines();
  const machineId = entry.mode === "local" ? entry.meta.machine : undefined;
  const machine = machineId ? (machines.find(m => m.id === machineId)?.name ?? "a removed machine") : null;
  const onThisComputer = entry.mode === "local" && !machineId;
  const items = useMemo(() => buildTimeline(session.events, session.pending), [session.events, session.pending]);
  // Approvals and queued messages wait above the composer; the timeline keeps a record of approvals.
  const stack = useMemo(() => waitingOnYou(items), [items]);
  const timelineItems = useMemo(() => withoutQueued(items), [items]);
  const subagents = useMemo(() => latestSubagents(session.events), [session.events]);
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
    loop.options ?? {
      model: summary.agent.model ?? null,
      reasoning: summary.agent.reasoning ?? null,
      permission: entry.mode === "cloud" ? "full" : "edits",
      ...(summary.agent.fast ? { fast: true } : {}),
    };
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
  // The thread has history this app hasn't got yet: it's on its way from the runner.
  const knownSeq = entry.mode === "local" ? entry.meta.lastSeq : entry.thread.latestSeq;
  const loadingHistory = useDelayed(knownSeq > 0 && session.events.length === 0 && session.state !== "offline" && session.state !== "error", 300);

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
    const ok = await confirmAction(removeThreadText(summary, machine));
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
    const toggle = () => activeRef.current && setPanelOpen(o => !o);
    window.addEventListener("lemonlime:toggle-panel", toggle);
    return () => window.removeEventListener("lemonlime:toggle-panel", toggle);
  }, []);
  // Find in thread (⌘F, handled by the app): pressing it again focuses the bar.
  const [find, setFind] = useState<number | null>(null);
  useEffect(() => {
    const open = () => activeRef.current && setFind(n => (n ?? 0) + 1);
    window.addEventListener("lemonlime:find", open);
    return () => window.removeEventListener("lemonlime:find", open);
  }, []);
  const timelineRef = useRef<HTMLDivElement>(null);
  // Opened from a subagent in the sidebar: scroll to the row it started from.
  const [revealChild, setRevealChild] = useState<string | null>(() => takeRevealChild(summary.id));
  useEffect(() => {
    const on = (e: Event) => {
      const id = takeRevealChild(summary.id);
      if (id && (e as CustomEvent<{ threadId: string }>).detail.threadId === summary.id) setRevealChild(id);
    };
    window.addEventListener(REVEAL_CHILD_EVENT, on);
    return () => window.removeEventListener(REVEAL_CHILD_EVENT, on);
  }, [summary.id]);
  useEffect(() => {
    if (!revealChild) return;
    const key = childRowKey(session.events, revealChild);
    // Not in the history yet: wait for it, unless the thread is already up to date.
    if (!key) return void (session.state === "live" && setRevealChild(null));
    const node = timelineRef.current?.querySelector<HTMLElement>(`[data-timeline-key="${key}"]`);
    node?.scrollIntoView({ block: "center" });
    flashItem(node);
    setRevealChild(null);
  }, [revealChild, session.events, session.state]);
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
  // ── Usage limits: carry on with another account or agent ───────
  const lastLimit = useMemo(() => items.findLast(i => i.kind === "limit"), [items]);
  const limitOpen = lastLimit?.kind === "limit" && lastLimit.open;
  const [accountList, setAccountList] = useState<AccountsList | null>(null);
  useEffect(() => {
    // Accounts are kept per computer; a thread on another machine uses the ones there.
    if (!onThisComputer || !limitOpen) return;
    let live = true;
    void listAccounts()
      .then(l => live && setAccountList(l))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [onThisComputer, limitOpen]);
  const [others, setOthers] = useState<{ ids: string[]; accountId: string } | null>(null);
  const { limitAction } = session;
  const limitActions = useMemo<LimitActions | undefined>(() => {
    if (session.state !== "live") return undefined;
    return {
      choices: hit =>
        limitChoices({ hit, mode: onThisComputer ? "local" : "cloud", model: threadOptions.model, accounts: accountList, agents: agents ?? null }),
      canSwitchAccount: onThisComputer,
      switchAccount: accountId => {
        limitAction({ action: "switch_account", accountId });
        if (entry.mode !== "local" || lastLimit?.kind !== "limit") return;
        const hit = lastLimit.hit;
        void localRunnerStatuses().then(statuses => {
          const ids = threadsOnSameLimit(statuses, entry.meta.id, hit.agent, hit.account?.id ?? DEFAULT_ACCOUNT_ID);
          setOthers(ids.length ? { ids, accountId } : null);
        });
      },
      switchAgent: (agent, model) => limitAction({ action: "switch_agent", agent, model }),
      wait: () => limitAction({ action: "wait" }),
      others:
        others && onSwitchOthers
          ? {
              count: others.ids.length,
              switchThem: async () => {
                await onSwitchOthers(others.ids, others.accountId);
                setOthers(null);
              },
            }
          : null,
    };
  }, [session.state, entry, onThisComputer, threadOptions.model, accountList, agents, limitAction, lastLimit, others, onSwitchOthers]);
  // A local thread that moved to another agent remembers it, for the sidebar and its next start.
  const lastSwitch = useMemo(() => session.events.findLast(e => e.type === "agent_switch"), [session.events]);
  useEffect(() => {
    if (entry.mode !== "local" || lastSwitch?.type !== "agent_switch") return;
    const to = lastSwitch.to;
    if (to.agent !== entry.meta.agent.kind || (to.agent !== lastSwitch.from.agent && to.model !== entry.meta.agent.model)) {
      onLocalAgent?.(entry.meta.id, { kind: to.agent, model: to.model });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSwitch?.seq]);
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
  // "hi" as a first message makes a poor title: a later message that says more names it.
  const userTexts = useMemo(() => session.events.flatMap(e => (e.type === "user_message" ? [e.text] : [])), [session.events]);
  useEffect(() => {
    if (!onAutoTitle) return;
    const better = betterTitle(summary.title, userTexts);
    if (better) onAutoTitle(better);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userTexts.length, summary.title]);
  /** Sends the message with its files; false (the text stays in the composer) when it can't go. */
  const sendWithFiles = (text: string): boolean => {
    const blocked = sendBlocker({ uploading: files.uploading });
    if (blocked) {
      setActionError(blocked);
      return false;
    }
    const plan = editSendPlan(editing, session.state === "live");
    if ("rewindTo" in plan) {
      // Go back to the edited message first; the new text goes once the runner has.
      setAfterRewind({ seq: plan.rewindTo, since: session.events.at(-1)?.seq ?? 0, text, files: files.ready });
      session.rewind(plan.rewindTo, false);
    } else if (!session.send(text, files.ready, { steer: followUp === "steer" && session.status === "running" })) {
      setActionError("Couldn't send that yet: the thread isn't connected. Your message is still in the box.");
      return false;
    }
    setActionError(null);
    saveDraft(summary.id, "");
    setEditing(null);
    files.clear();
    return true;
  };
  // ── Editing a sent message ─────────────────────────────
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const beforeEdit = useRef("");
  const [afterRewind, setAfterRewind] = useState<{ seq: number; since: number; text: string; files: string[] } | null>(null);
  const editMessage = (item: Extract<TimelineItem, { kind: "user" }>) => {
    const draft = startEdit(item, session.state === "live");
    if (!draft) return;
    if (!editing) beforeEdit.current = composerWrap.current?.querySelector("textarea")?.value ?? "";
    setEditing(draft);
    composerRef.current?.fill(draft.text);
  };
  const stopEditing = () => {
    setEditing(null);
    composerRef.current?.fill(beforeEdit.current);
  };
  const { send: sessionSend } = session;
  useEffect(() => {
    if (!afterRewind) return;
    if (rewindLanded(session.events, afterRewind.seq, afterRewind.since)) {
      setAfterRewind(null);
      sessionSend(afterRewind.text, afterRewind.files);
      return;
    }
    // The runner didn't go back (it may have said why): give the text back rather than lose it.
    const t = setTimeout(() => {
      setAfterRewind(null);
      composerRef.current?.fill(afterRewind.text);
      setActionError("Couldn't go back to that message. Your edited text is back in the message box.");
    }, 10_000);
    return () => clearTimeout(t);
  }, [session.events, afterRewind, sessionSend]);
  // ── Forking into a new thread ──────────────────────────
  const [forking, setForking] = useState(false);
  const fork = (key: string, quote?: string) => {
    if (!onFork || forking) return;
    const note = forkNote(
      items,
      { key, quote },
      {
        title: summary.title,
        branch: summary.branch,
        baseBranch: entry.mode === "local" ? entry.meta.baseBranch : entry.thread.repo.baseBranch,
      },
    );
    if (!note) return;
    setForking(true);
    setActionError(null);
    onFork(entry, note, forkTitle(summary.title))
      .catch(err => setActionError(err instanceof Error ? err.message : String(err)))
      .finally(() => setForking(false));
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
  // The side panel's tabs, kept per thread.
  const [panel, setPanelState] = useState<PanelState>(() => loadPanelState(summary.id));
  const setPanel = (update: (s: PanelState) => PanelState) => setPanelState(s => update(s));
  useEffect(() => savePanelState(summary.id, panel), [summary.id, panel]);
  const [quickOpen, setQuickOpen] = useState(false);
  // File paths in the agent's replies open in the side panel's file view.
  const fileLinksRoot = entry.mode === "local" ? entry.meta.repoPath : null;
  const fileLinks = useMemo<FileLinks>(
    () => ({
      root: fileLinksRoot,
      open: ref => {
        setPanelState(s => openFile(s, ref.path));
        setPanelOpen(true);
      },
    }),
    [fileLinksRoot],
  );
  useEffect(() => {
    const open = () => setQuickOpen(true);
    const reopen = () => {
      setPanelState(reopenTab);
      setPanelOpen(true);
    };
    window.addEventListener("lemonlime:quick-open", open);
    window.addEventListener("lemonlime:reopen-tab", reopen);
    return () => {
      window.removeEventListener("lemonlime:quick-open", open);
      window.removeEventListener("lemonlime:reopen-tab", reopen);
    };
  }, []);

  // Subagents and background commands; messages held (⌥Enter) until the subagents finish.
  const work = useMemo(() => backgroundWork(session.events), [session.events]);
  const workKey = work.children.map(c => `${c.id}:${c.state}`).join(",");
  useEffect(() => {
    onChildren?.(summary.id, work.children);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workKey]);
  const [held, setHeld] = useState<HeldMessage[]>([]);
  const settled = childrenSettled(work.children);
  const hold = (text: string): boolean => {
    if (settled) return sendWithFiles(text);
    saveDraft(summary.id, "");
    setHeld(h => [...h, { id: crypto.randomUUID(), text }]);
    return true;
  };
  const sendHeld = (id: string) => {
    const m = held.find(h => h.id === id);
    if (!m) return;
    setHeld(h => h.filter(x => x.id !== id));
    session.send(m.text);
  };
  useEffect(() => {
    if (!settled || !held.length || session.state !== "live") return;
    const all = held;
    setHeld([]);
    for (const m of all) session.send(m.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, held.length, session.state]);

  // Put text into the message being written (e.g. lines picked in a diff), after what's there.
  // Other parts of the app can do the same with a "lemonlime:composer-insert" event ({ text }).
  const composerWrap = useRef<HTMLDivElement>(null);
  const insertIntoComposer = (text: string) => composerRef.current?.insert(text);
  // Unsent text stays with the thread: the composer keeps it (draftKey), and the sidebar marks it.
  const insertRef = useRef(insertIntoComposer);
  insertRef.current = insertIntoComposer;
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text === "string" && text && activeRef.current) insertRef.current(text);
    };
    window.addEventListener("lemonlime:composer-insert", onInsert);
    return () => window.removeEventListener("lemonlime:composer-insert", onInsert);
  }, []);

  // Typing or pasting with nothing else to take it lands in this pane's message box.
  const addFilesRef = useRef(files.add);
  addFilesRef.current = files.add;
  useEffect(() => {
    const box = () => {
      const el = composerWrap.current?.querySelector("textarea");
      return activeRef.current && el && !el.disabled && el.getClientRects().length > 0 ? el : null;
    };
    const onKey = (e: KeyboardEvent) => {
      const el = box();
      if (!el || !typingGoesToComposer(e, focusFacts())) return;
      // Moving focus now sends this key's character to the box.
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };
    const onPaste = (e: ClipboardEvent) => {
      const el = box();
      if (!el || !e.clipboardData || !pasteGoesToComposer(focusFacts())) return;
      const pasted = [...e.clipboardData.files];
      const text = e.clipboardData.getData("text/plain");
      if (!pasted.length && !text) return;
      e.preventDefault();
      if (pasted.length) addFilesRef.current(pasted);
      else composerRef.current?.paste(text);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  // The branch as git sees it, refreshed when the agent changes files or a turn ends.
  const fileDiffs = useMemo(() => session.events.filter(e => e.type === "file_diff").length, [session.events]);
  const gitRefresh = `${fileDiffs}:${liveStatus ?? ""}`;
  const git = useGitState({ connection: session.connection, mode: entry.mode, threadId: summary.id, cloudApi, refreshKey: gitRefresh });
  // A likely next message once the turn is over, from the thread itself.
  const uncommittedFiles = git.status?.uncommittedFiles;
  const suggestion = useMemo(
    () => (suggestNext && !working && session.pending.length === 0 ? suggestNextPrompt(session.events, { uncommittedFiles }) : null),
    [suggestNext, working, session.pending.length, session.events, uncommittedFiles],
  );
  const showChanges = () => {
    setPanel(s => ({ ...s, active: "changes" }));
    setPanelOpen(true);
  };
  // Split view: focusing the pane (⌘1…⌘6, or a new split) puts the cursor in its composer.
  useEffect(() => {
    if (!focusNonce) return;
    const r = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(r);
  }, [focusNonce]);
  // A narrow pane has no room beside the conversation: its panel lies on top, in the active pane only.
  const narrow = room !== undefined && room > 0 && room < NARROW_PANE_PX;
  const panelShown = panelOpen && (!narrow || active);

  const runAction =
    entry.mode === "local"
      ? session.state === "offline" || session.state === "error"
        ? { label: "Start", icon: <Play aria-hidden="true" className="size-3.5" />, onClick: session.restart, disabled: busy }
        : { label: "Stop", icon: <Power aria-hidden="true" className="size-3.5" />, onClick: stopLocal, disabled: busy || session.state === "starting" }
      : cloudStatus === "paused" || cloudStatus === "stopped"
        ? { label: "Resume", icon: <Play aria-hidden="true" className="size-3.5" />, onClick: resumeCloud, disabled: busy }
        : {
            label: "Pause",
            icon: <Pause aria-hidden="true" className="size-3.5" />,
            onClick: pauseCloud,
            disabled: busy || cloudStatus === "provisioning" || cloudStatus === "failed",
          };

  const compact = paneControls !== undefined;
  const [renaming, setRenaming] = useState(false);
  const pr = git.pullRequest;
  const [prLink, prNumber, prState, prDraft] = [pr?.url ?? null, pr?.number, pr?.state, pr?.draft];
  useEffect(
    () => rememberPullRequest(summary.id, prLink, prLink ? { number: prNumber, state: prState, draft: prDraft } : undefined),
    [summary.id, prLink, prNumber, prState, prDraft],
  );
  const canPr = git.available && (git.status !== null || entry.mode === "cloud");
  const noRemote = entry.mode === "local" && !git.status?.hasRemote;
  const menuActions: ThreadMenuHandlers = {
    ...threadMenu?.actions,
    ...(threadMenu?.onRename && !compact ? { rename: () => setRenaming(true) } : {}),
    ...(onOpenFolder ? { openFolder: onOpenFolder } : machine ? { openFolder: () => undefined } : {}),
    ...(pr ? { pullRequest: () => void openExternal(pr.url) } : canPr ? { pullRequest: () => void git.openPullRequest() } : {}),
    ...(AGENT_CAPABILITIES[summary.agent.kind].compact ? { compact: session.compact } : {}),
    ...(onMove ? { move: () => void move() } : {}),
    ...(entry.mode === "local" ? { remove: () => void removeLocal() } : {}),
  };
  const optionsMenu = (
    <ThreadMenu
      thread={summary}
      state={{
        mode: entry.mode,
        pinned: threadMenu?.pinned ?? false,
        unread: threadMenu?.unread ?? false,
        archived: false,
        inSplit: threadMenu?.inSplit ?? false,
        editor: threadMenu?.editor ?? false,
        pullRequest: pr ? "view" : canPr ? "open" : null,
        disabled: {
          ...(session.state !== "live" || working ? { compact: "" } : {}),
          ...(!session.connection || working || moving !== null ? { move: "" } : {}),
          ...(machine ? { "open-folder": "This computer only" } : {}),
          ...(!pr && canPr && (noRemote || git.busy !== null) ? { "pull-request": noRemote ? "No remote" : "" } : {}),
        },
      }}
      actions={menuActions}
      extra={
        entry.mode === "cloud" ? (
          <>
            {(summary.agent.kind === "claude-code" || summary.agent.kind === "codex") && (
              <MenuItem icon={<KeyRound />} disabled={session.state !== "live"} onSelect={() => setShowSignIn(true)}>
                Sign the agent in…
              </MenuItem>
            )}
            <SubMenu icon={<Monitor />} label={`This computer: ${COMPUTER_LEVELS.find(l => l.value === computerLevel)?.label ?? "Off"}`}>
              <MenuLabel>What the agent may do on this computer</MenuLabel>
              <MenuChoice
                value={computerLevel}
                onChange={onComputerLevel}
                options={COMPUTER_LEVELS.map(l => ({ value: l.value, label: <span title={l.hint}>{l.label}</span> }))}
              />
            </SubMenu>
          </>
        ) : undefined
      }
      trigger={
        <button
          type="button"
          aria-label="Thread options"
          className={cx(
            "inline-flex items-center justify-center text-ink-soft hover:bg-cream-deep data-[popup-open]:bg-cream-deep",
            compact ? "size-7 shrink-0 rounded-md" : "size-8 rounded-lg",
          )}
        >
          <Ellipsis aria-hidden="true" className={compact ? "size-3.5" : "size-4"} />
        </button>
      }
    />
  );
  const panelToggle = (
    <Tip label={panelOpen ? "Hide panel" : "Show changes and terminal"} side="bottom">
      <button
        type="button"
        aria-label={panelOpen ? "Hide panel" : "Show changes and terminal"}
        aria-pressed={panelOpen}
        onClick={() => setPanelOpen(o => !o)}
        className={cx(
          "inline-flex items-center justify-center text-ink-soft hover:bg-cream-deep",
          compact ? "size-7 shrink-0 rounded-md" : "size-8 rounded-lg",
          panelOpen && "bg-cream-deep text-ink",
        )}
      >
        <PanelRight aria-hidden="true" className={compact ? "size-3.5" : "size-4"} />
      </button>
    </Tip>
  );

  return (
    <div className="relative flex min-w-0 flex-1">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={`Thread ${summary.title}`}>
        {paneControls ? (
          <PaneHeader
            active={active}
            title={summary.title}
            controls={paneControls}
            glyph={!online ? <ConnectionGlyph state="offline" status={null} label="Offline" /> : <ConnectionGlyph state={session.state} status={liveStatus} />}
          >
            <PaneButton label={runAction.label} onClick={() => void runAction.onClick()} disabled={runAction.disabled}>
              {runAction.icon}
            </PaneButton>
            {optionsMenu}
            {panelToggle}
          </PaneHeader>
        ) : (
          <header data-tauri-drag-region className="@container/head flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-5">
            {/* The title always keeps some room; buttons drop their words first (see @max-…/head). */}
            <div data-tauri-drag-region className="flex min-w-[120px] flex-1 items-center gap-2.5">
              {renaming && threadMenu?.onRename ? (
                <RenameField
                  className="max-w-[420px] text-[15px] font-semibold"
                  initial={summary.title}
                  onDone={title => {
                    setRenaming(false);
                    if (title && title !== summary.title) threadMenu.onRename?.(title);
                  }}
                />
              ) : (
                <h1
                  className="min-w-0 truncate font-sans text-[15px] font-semibold tracking-normal text-ink"
                  onDoubleClick={threadMenu?.onRename ? () => setRenaming(true) : undefined}
                >
                  {summary.title}
                </h1>
              )}
              <span
                className="hidden min-w-0 items-center gap-1.5 truncate text-[14px] text-ink-faint md:inline-flex @max-[640px]/head:hidden"
                title={summary.repo}
              >
                {machine ? (
                  <Server aria-hidden="true" className="size-3.5 shrink-0" />
                ) : summary.mode === "local" ? (
                  <Laptop aria-hidden="true" className="size-3.5 shrink-0" />
                ) : (
                  <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{machine ? `${repoName(summary.repo)} on ${machine}` : repoName(summary.repo)}</span>
              </span>
            </div>
            {git.available && (git.status || entry.mode === "cloud") && <GitActionsButton git={git} mode={entry.mode} />}
            {!online ? (
              <span
                role="status"
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-cream-deep px-2.5 text-[13px] font-medium text-ink-soft"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-control" />
                Offline
              </span>
            ) : (
              <ConnectionBadge state={session.state} status={liveStatus} />
            )}
            <Button size="sm" variant="ghost" onClick={runAction.onClick} disabled={runAction.disabled} title={runAction.label}>
              {runAction.icon}
              <span className="@max-[640px]/head:sr-only">{runAction.label}</span>
            </Button>
            {optionsMenu}
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
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-lemon-line bg-lemon-soft px-2.5 text-[13px] font-medium text-ink hover:bg-lemon"
                >
                  <ArrowUpCircle aria-hidden="true" className="size-3.5" />
                  {copiedUpdate ? "Copied update command" : `Update ${AGENT_LABELS[summary.agent.kind]}`}
                </button>
              </Tip>
            )}
            {panelToggle}
          </header>
        )}

        {denial && (
          <div className="flex items-center gap-3 border-b border-lemon-line bg-lemon-soft px-6 py-2.5 text-[14px] text-ink" role="alert">
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
          <div role="status" className="flex items-center gap-3 border-b border-line bg-lemon-soft px-6 py-2.5 text-[14px] text-ink">
            <Spinner />
            <p className="min-w-0 flex-1">{moving}</p>
          </div>
        )}
        {errorText && (
          <div className="flex items-center gap-3 border-b border-danger/20 bg-danger-soft px-6 py-2.5 text-[14px]" role="alert">
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
          <FileLinksContext.Provider value={fileLinks}>
            <Timeline
              threadId={summary.id}
              foldFinished={foldFinished}
              items={timelineItems}
              working={working}
              unreadAfterSeq={unreadAt}
              loadImage={loadImage}
              empty={
                loadingHistory ? (
                  <HistorySkeleton />
                ) : (
                  <EmptyThread state={session.state} mode={summary.mode} branch={summary.branch} cloudStatus={cloudStatus} machine={machine} />
                )
              }
              onRewind={rewindTo}
              onEdit={editMessage}
              onFork={onFork ? fork : undefined}
              subagents={subagents}
              onImplementPlan={session.state === "live" ? implementPlan : undefined}
              limit={limitActions}
            />
          </FileLinksContext.Provider>
          {find !== null && <FindBar root={timelineRef} version={timelineItems} focusNonce={find} onClose={() => setFind(null)} />}
          <SelectionQuote root={timelineRef} onQuote={text => composerRef.current?.quote(text)} onFork={onFork ? fork : undefined} />
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
            {stack.approvals[0] && (
              <ApprovalCard
                key={stack.approvals[0].requestId}
                item={stack.approvals[0]}
                more={stack.approvals.length - 1}
                onApprove={session.state === "live" ? session.approve : undefined}
              />
            )}
            {loop.question && (
              <QuestionCard
                key={loop.question.requestId}
                request={loop.question}
                onAnswer={session.state === "live" ? answers => session.answerQuestion(loop.question!.requestId, answers) : undefined}
              />
            )}
            {editing && <EditingCard draft={editing} onReplace={replace => setEditing(d => (d ? { ...d, replace } : d))} onCancel={stopEditing} />}
            <QueuedCard queued={stack.queued} onEdit={session.editQueued} />
            {loop.todos && <TodoCard items={loop.todos} />}
            <BackgroundWorkCard
              work={work}
              held={held}
              onSendHeld={sendHeld}
              onCancelHeld={id => {
                const m = held.find(h => h.id === id);
                setHeld(h => h.filter(x => x.id !== id));
                if (m) composerRef.current?.fill(m.text);
              }}
            />
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
                    <span className="min-w-0 truncate">{attachmentLabel(a.name)}</span>
                    <span className="shrink-0 text-[12px] text-ink-faint tabular-nums">
                      {a.state === "uploading" ? `${Math.floor((a.sent / Math.max(1, a.size)) * 100)}%` : a.state === "failed" ? "Failed" : ""}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachmentLabel(a.name)}`}
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
              onHold={hold}
              onLongPaste={pasted => {
                if (!session.connection) return false;
                files.add([
                  pastedTextFile(
                    pasted,
                    files.items.map(a => a.name),
                  ),
                ]);
                return true;
              }}
              suggestions={composerSuggestions}
              history={prompts}
              draftKey={summary.id}
              placeholder="Add to the conversation…"
              suggestion={suggestion}
              onInterrupt={session.interrupt}
              working={working}
              disabled={composerDisabled}
              tools={
                <span className="@container/tools flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[14px] text-ink-soft">
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
                  {/* In a narrow pane the branch gives way first, so the pickers keep their names. */}
                  <span className="inline-flex min-w-0 shrink-[40] items-center gap-1.5 font-mono text-[13px] @max-[420px]/tools:hidden" title={summary.branch}>
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
                  ? machine
                    ? `Connecting to ${machine}…`
                    : summary.mode === "local"
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
        // Kept mounted while hidden, so a terminal keeps its screen.
        <ThreadPanel
          hidden={!panelShown}
          overlay={narrow}
          state={panel}
          onState={setPanel}
          session={session}
          // Previews from another machine come through a tunnel, like a cloud sandbox's.
          mode={onThisComputer ? "local" : "cloud"}
          runnerPath={runnerPath}
          onClose={() => setPanelOpen(false)}
          refreshKey={gitRefresh}
          onQuickOpen={() => setQuickOpen(true)}
          shortcuts={{ quickOpen: keysFor("quick-open", shortcuts), reopen: keysFor("reopen-tab", shortcuts) }}
          onAddToChat={text => {
            insertIntoComposer(text);
            composerRef.current?.focus();
          }}
        />
      )}
      <QuickOpen
        open={quickOpen}
        onOpenChange={setQuickOpen}
        searchFiles={suggestions.searchFiles}
        connected={session.connection !== null}
        onPick={path => {
          setPanel(s => openFile(s, path));
          setPanelOpen(true);
        }}
      />
    </div>
  );
}

/** True once `on` has stayed true for `ms`, so quick loads never flash a placeholder. */
function useDelayed(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) return setLate(false);
    const t = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && late;
}

/** The shape of a conversation while its history loads: a message, a few steps, a reply. */
function HistorySkeleton() {
  const bar = "rounded-md bg-cream-deep animate-pulse-soft";
  return (
    <div role="status" aria-label="Loading the conversation" className="flex flex-col">
      <div className="flex justify-end">
        <div className={cx(bar, "h-10 w-[46%] rounded-2xl rounded-br-md")} />
      </div>
      <div className="mt-6 flex flex-col gap-2.5 pl-1.5">
        {[38, 52, 30].map(w => (
          <div key={w} className="flex items-center gap-2">
            <div className={cx(bar, "size-3.5")} />
            <div className={bar} style={{ width: `${w}%`, height: 12 }} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-3">
        <div className={cx(bar, "size-[22px] shrink-0 rounded-full")} />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <div className={bar} style={{ width: "88%", height: 12 }} />
          <div className={bar} style={{ width: "72%", height: 12 }} />
          <div className={bar} style={{ width: "40%", height: 12 }} />
        </div>
      </div>
    </div>
  );
}

function EmptyThread({
  state,
  mode,
  branch,
  cloudStatus,
  machine,
}: {
  state: SessionState;
  mode: "local" | "cloud";
  branch: string;
  cloudStatus: ThreadStatus | null;
  machine: string | null;
}) {
  let heading = "Tell the agent what to work on";
  let body = (
    <>
      Everything it changes lands on <span className="font-mono text-[13px] text-ink">{branch}</span>, so your other branches stay as they are.
    </>
  );
  if (state === "starting") {
    heading = machine ? `Connecting to ${machine}` : mode === "local" ? "Starting the runner" : "Connecting";
    body = machine ? <>Starting the runner there over SSH. This takes a moment the first time.</> : <>This takes a moment the first time.</>;
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
      <p className="mt-1.5 text-[14px] text-ink-soft">{body}</p>
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

function connectionLabel(state: SessionState, status: ThreadStatus | null): string {
  const offlineStatus = state === "offline" && (status === "paused" || status === "provisioning" || status === "failed");
  return (state === "live" || offlineStatus) && status ? STATUS_LABELS[status] : STATE_LABEL[state];
}

function connectionDot(state: SessionState, status: ThreadStatus | null) {
  return state === "live" ? (
    <StatusDot status={status ?? "idle"} />
  ) : state === "error" ? (
    <StatusDot status="failed" />
  ) : state === "offline" ? (
    <StatusDot status="offline" />
  ) : (
    <span className="inline-block size-2 animate-pulse-soft rounded-full bg-lemon" aria-hidden="true" />
  );
}

/** The connection as a single mark, for a pane's slim header. */
function ConnectionGlyph({ state, status, label = connectionLabel(state, status) }: { state: SessionState; status: ThreadStatus | null; label?: string }) {
  return (
    <span role="status" aria-label={label} title={label} className="inline-flex size-4 shrink-0 items-center justify-center [&_[role=img]]:pointer-events-none">
      {connectionDot(state, status)}
    </span>
  );
}

function ConnectionBadge({ state, status }: { state: SessionState; status: ThreadStatus | null }) {
  const label = connectionLabel(state, status);
  const dot = connectionDot(state, status);
  return (
    <span
      className={cx(
        "inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[13px]",
        state === "error" ? "border-danger/25 bg-danger-soft text-danger" : "border-line bg-paper text-ink-soft",
      )}
      role="status"
      aria-live="polite"
      title={`Connection: ${STATE_LABEL[state]}. ${label}`}
    >
      {dot}
      <span className="@max-[640px]/head:sr-only">{label}</span>
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
