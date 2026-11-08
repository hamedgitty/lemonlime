import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { branchForThread, isSafeBranchPrefix, newThreadId, type AgentKind, type Thread, type ThreadStatus } from "@lemonlime/protocol";
import { AppSidebar } from "./components/AppSidebar.tsx";
import { AutomationsView } from "./components/AutomationsView.tsx";
import { Home } from "./components/Home.tsx";
import { SetupWizard } from "./components/SetupWizard.tsx";
import { SkillsView } from "./components/SkillsView.tsx";
import { PluginsView } from "./components/PluginsView.tsx";
import { GlobalPanel, type PanelTab } from "./components/GlobalPanel.tsx";
import { AgentScans, ImportChats } from "./components/ImportChats.tsx";
import { mergeImportedThreads } from "./lib/history.ts";
import { needsUpdate } from "./components/settings/AgentsPage.tsx";
import { TipProvider } from "./components/primitives.tsx";
import { SETTINGS_PAGES, SettingsSidebar, SettingsView, type SettingsCtx, type SettingsPage } from "./components/SettingsView.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { Toaster, toast } from "./components/Toaster.tsx";
import { rowGlyph, isUnread, waitingCount, type RowGlyph } from "./lib/threadState.ts";
import { Button, cx, openExternal } from "./components/ui.tsx";
import { CloudApi, CloudError, isCloudConfigured } from "./lib/cloud.ts";
import { AGENT_LABELS, repoName, titleFromPrompt } from "./lib/format.ts";
import { keysFor, matchShortcut, type ShortcutId } from "./lib/shortcuts.ts";
import { appCommands, loadRecents, rememberPick, type PaletteItem } from "./lib/palette.ts";
import { detectAgents, localRunnerStatuses, notify, openFolder, setKeepAwake, threadFolder, type AgentInstall } from "./lib/system.ts";
import {
  confirmAction,
  inDesktopShell,
  inspectRepo,
  listLocalRunners,
  loadAccessToken,
  pickFolder,
  removeLocalThread,
  saveAccessToken,
  setRunnerDefaults,
  stopLocalRunner,
} from "./lib/native.ts";
import { resolveConnection, type Connection } from "./lib/useThreadSession.ts";
import { setAccountsRunnerPath, switchThreadsAccount } from "./lib/accounts.ts";
import { teleportThread } from "@lemonlime/client";
import { acceptSignInLink, onSignInLink } from "./lib/desktopAuth.ts";
import { checkForUpdate, type AvailableUpdate } from "./lib/updates.ts";
import { DeniedError, type NewThreadInput } from "./lib/newThread.ts";
import {
  draftThreadIds,
  forgetEvents,
  loadLocalThreads,
  loadSettings,
  loadUiPrefs,
  saveLocalThreads,
  saveSettings,
  saveUiPrefs,
  type LocalThreadMeta,
  type Settings,
  type UiPrefs,
} from "./lib/storage.ts";
import { loadComputerAccess, setComputerAccess } from "./lib/computer.ts";
import { sortByActivity, summarize, type ThreadEntry, type ThreadSummary } from "./lib/threads.ts";

type Selection = { mode: "local" | "cloud"; id: string };
/** Where the app is. Back and forward move through these. */
type Place =
  | { view: "home" }
  | { view: "thread"; selection: Selection }
  | { view: "settings"; page: SettingsPage }
  | { view: "automations" }
  | { view: "skills" }
  | { view: "plugins" };

const CLOUD_REFRESH_MS = 15_000;
const RUNNER_POLL_MS = 5_000;

/** The macOS app window draws its traffic lights over the sidebar. */
const MAC_CHROME = inDesktopShell() && /Mac/.test(navigator.userAgent);
/** Archived threads on this computer are removed after this many days. */
const ARCHIVE_KEEP_DAYS = 21;

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [prefs, setPrefs] = useState<UiPrefs>(loadUiPrefs);
  const [localThreads, setLocalThreads] = useState<LocalThreadMeta[]>(loadLocalThreads);
  const [cloudThreads, setCloudThreads] = useState<Thread[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<{ stack: Place[]; at: number }>({ stack: [{ view: "home" }], at: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteRecents, setPaletteRecents] = useState<string[]>(loadRecents);
  const place = history.stack[history.at]!;

  const go = useCallback((next: Place) => {
    setHistory(h => {
      const cur = h.stack[h.at];
      if (cur && JSON.stringify(cur) === JSON.stringify(next)) return h;
      const stack = [...h.stack.slice(0, h.at + 1), next].slice(-50);
      return { stack, at: stack.length - 1 };
    });
  }, []);
  const back = history.at > 0 ? () => setHistory(h => ({ ...h, at: h.at - 1 })) : null;
  const forward = history.at < history.stack.length - 1 ? () => setHistory(h => ({ ...h, at: h.at + 1 })) : null;

  // The access token comes from the keychain. A token an older version left in local
  // storage is moved there once, then cleared from local storage.
  useEffect(() => {
    const legacy = settings.accessToken;
    void (async () => {
      try {
        if (legacy) {
          await saveAccessToken(legacy);
          saveSettings({ ...settings, accessToken: "" });
        }
        const token = legacy || (await loadAccessToken());
        if (token) setSettings(s => ({ ...s, accessToken: token }));
      } catch (err) {
        console.warn("Could not read the access token from the keychain", err);
      }
    })();
    // Runs once at start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quitting while an agent on this computer is mid-turn asks first (the app holds the quit).
  const workingLocally = localThreads.some(m => m.status === "running" && running.has(m.id));
  const workingRef = useRef(workingLocally);
  workingRef.current = workingLocally;
  useEffect(() => {
    if (!inDesktopShell()) return;
    let off: () => void = () => undefined;
    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]);
      off = await listen("confirm-quit", async () => {
        if (
          workingRef.current &&
          !(await confirmAction("An agent on this computer is still working. Quit anyway? It stops now, and what it changed so far stays on its branch."))
        )
          return;
        await invoke("confirm_quit");
      });
    })();
    return () => off();
  }, []);

  // A newer signed version: offer it quietly, never interrupt.
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => void checkForUpdate().then(setUpdate), 10_000);
    const daily = setInterval(() => void checkForUpdate().then(setUpdate), 6 * 60 * 60_000);
    return () => {
      clearTimeout(t);
      clearInterval(daily);
    };
  }, []);

  // Coming back from "Sign in with your browser": keep the token and connect.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let stop: () => void = () => undefined;
    void onSignInLink(link => {
      const ok = acceptSignInLink(link);
      if (!ok) return;
      setSettings(s => {
        const next = { ...s, controlPlaneUrl: ok.url, accessToken: ok.token };
        saveSettings(next);
        return next;
      });
      void saveAccessToken(ok.token).catch(err => console.warn("Could not save the access token to the keychain", err));
      setSignedIn(true);
    }).then(off => (stop = off));
    return () => stop();
  }, []);

  // The latest prefs, for callbacks that run later (an Undo in a toast).
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onPrefs = useCallback((patch: Partial<UiPrefs>) => {
    setPrefs(p => {
      const next = { ...p, ...patch };
      saveUiPrefs(next);
      return next;
    });
  }, []);

  // What each cloud thread may do on this computer is kept by the app's native side; show
  // what it holds (a level set in an older version has to be granted again there).
  useEffect(() => {
    void loadComputerAccess().then(levels => levels && onPrefs({ computerAccess: levels }));
  }, [onPrefs]);

  // ── Theme ────────────────────────────────────────────────
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = prefs.theme === "dark" || (prefs.theme === "system" && Boolean(media?.matches));
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (prefs.theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [prefs.theme]);

  // ── Agent CLIs on this computer ──────────────────────────
  const [agents, setAgents] = useState<AgentInstall[] | null>(null);
  const refreshAgents = useCallback(() => {
    if (!inDesktopShell()) return setAgents([]);
    setAgents(null);
    void detectAgents().then(setAgents, () => setAgents([]));
  }, []);
  useEffect(() => {
    refreshAgents();
    const t = setInterval(() => void detectAgents().then(setAgents, () => undefined), 6 * 60 * 60_000);
    return () => clearInterval(t);
  }, [refreshAgents]);
  const agentUpdates = useMemo(() => (agents ?? []).filter(needsUpdate).map(a => AGENT_LABELS[a.kind]), [agents]);

  // ── Setup wizard and composer drafts ─────────────────────
  // First run opens setup; it stays open until finished or skipped, even once chats are imported.
  const [setupOpen, setSetupOpen] = useState(() => !prefs.setupDone && localThreads.length === 0);
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);

  // ── The side panel on every page (terminals on this computer, a browser) ──
  const [panelTabs, setPanelTabs] = useState<PanelTab[]>([]);
  const [panelActive, setPanelActive] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const togglePanel = useCallback(() => {
    setPanelOpen(open => {
      if (!open)
        setPanelTabs(tabs => {
          if (tabs.length) return tabs;
          const id = crypto.randomUUID();
          setPanelActive(id);
          return [{ id, kind: "new", title: "New tab" }];
        });
      return !open;
    });
  }, []);

  const cloudConfigured = isCloudConfigured(settings);
  const cloudApi = useMemo(
    () =>
      cloudConfigured
        ? new CloudApi({ url: settings.controlPlaneUrl, token: settings.accessToken, workspaceId: settings.cloudWorkspaceId || undefined })
        : null,
    [cloudConfigured, settings.controlPlaneUrl, settings.accessToken, settings.cloudWorkspaceId],
  );

  useEffect(() => saveLocalThreads(localThreads), [localThreads]);

  // Settings → Agents and Instructions reach every local runner as it starts.
  useEffect(() => {
    setRunnerDefaults({
      instructions: settings.instructions,
      stripCoauthors: settings.stripCoauthors,
      branchPrefix: settings.branchPrefix,
      retryMaxWaitMinutes: settings.retryMaxWaitMinutes,
      disabledSkills: settings.disabledSkills,
      commandGuard: settings.commandGuard,
    });
  }, [settings.instructions, settings.stripCoauthors, settings.branchPrefix, settings.retryMaxWaitMinutes, settings.disabledSkills, settings.commandGuard]);

  useEffect(() => setAccountsRunnerPath(settings.runnerPath), [settings.runnerPath]);

  // ── Local runners ────────────────────────────────────────
  // What each local runner is doing, including threads that aren't open (for notifications and keep awake).
  const [localStatus, setLocalStatus] = useState<Record<string, ThreadStatus>>({});
  const [localWaiting, setLocalWaiting] = useState<Record<string, number>>({});
  const [localSeq, setLocalSeq] = useState<Record<string, number>>({});
  const refreshRunners = useCallback(() => {
    void listLocalRunners()
      .then(ids => setRunning(prev => (sameSet(prev, ids) ? prev : new Set(ids))))
      .catch(() => undefined);
    void localRunnerStatuses()
      .then(list => {
        const next: Record<string, ThreadStatus> = {};
        const waiting: Record<string, number> = {};
        const seqs: Record<string, number> = {};
        for (const r of list) {
          if (r.health.status) next[r.threadId] = r.health.status;
          if (r.health.waitingApprovals) waiting[r.threadId] = r.health.waitingApprovals;
          if (typeof r.health.latestSeq === "number") seqs[r.threadId] = r.health.latestSeq;
        }
        setLocalSeq(prev => (JSON.stringify(prev) === JSON.stringify(seqs) ? prev : seqs));
        setLocalStatus(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        setLocalWaiting(prev => (JSON.stringify(prev) === JSON.stringify(waiting) ? prev : waiting));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshRunners();
    const t = setInterval(refreshRunners, RUNNER_POLL_MS);
    return () => clearInterval(t);
  }, [refreshRunners]);

  // ── Cloud threads ────────────────────────────────────────
  const refreshCloud = useCallback(() => {
    if (!cloudApi) {
      setCloudThreads([]);
      setCloudError(null);
      return;
    }
    setCloudLoading(true);
    cloudApi
      .listThreads()
      .then(list => {
        setCloudThreads(list);
        setCloudError(null);
      })
      .catch(err => setCloudError(err instanceof CloudError ? err.message : String(err)))
      .finally(() => setCloudLoading(false));
  }, [cloudApi]);

  useEffect(() => {
    refreshCloud();
    if (!cloudApi) return;
    const t = setInterval(refreshCloud, CLOUD_REFRESH_MS);
    return () => clearInterval(t);
  }, [cloudApi, refreshCloud]);

  // The deployment's usage banner (e.g. running low on cloud hours).
  const [usage, setUsage] = useState<Awaited<ReturnType<CloudApi["usageNotice"]>>>(null);
  const [summary, setSummary] = useState<Awaited<ReturnType<CloudApi["usageSummary"]>>>(null);
  useEffect(() => {
    if (!cloudApi) {
      setUsage(null);
      setSummary(null);
      return;
    }
    const load = () => {
      void cloudApi.usageNotice().then(setUsage, () => setUsage(null));
      void cloudApi.usageSummary().then(setSummary, () => setSummary(null));
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [cloudApi]);

  // ── Keep awake while an agent here works ─────────────────
  const anyLocalWorking = Object.values(localStatus).some(st => st === "running");
  useEffect(() => {
    void setKeepAwake(prefs.keepAwake && anyLocalWorking, prefs.keepDisplayOn).catch(err => console.warn("Keep awake", err));
  }, [prefs.keepAwake, prefs.keepDisplayOn, anyLocalWorking]);

  // ── Notifications: a thread finished or failed ───────────
  const lastStatus = useRef<Record<string, ThreadStatus>>({});
  const placeRef = useRef<Place>(place);
  placeRef.current = place;
  useEffect(() => {
    const now: Record<string, { status: ThreadStatus; title: string; mode: "local" | "cloud" }> = {};
    for (const m of localThreads) if (localStatus[m.id]) now[m.id] = { status: localStatus[m.id]!, title: m.title, mode: "local" };
    for (const t of cloudThreads) now[t.id] = { status: t.status, title: t.title || repoName(t.repo.url), mode: "cloud" };
    const n = prefs.notifications;
    for (const [id, cur] of Object.entries(now)) {
      const before = lastStatus.current[id];
      lastStatus.current[id] = cur.status;
      if (!n.enabled || !before || before === cur.status || prefs.archived[id]) continue;
      const p = placeRef.current;
      const watching = p.view === "thread" && p.selection.id === id && document.hasFocus();
      if (watching && !n.whenFocused) continue;
      if (before === "running" && cur.status === "idle" && n.finished) void notify(cur.title || "Thread finished", "The agent finished its turn.");
      else if (cur.status === "failed" && n.failed) void notify(cur.title || "Thread failed", "Something went wrong. Open the thread to see what happened.");
    }
  }, [localThreads, localStatus, cloudThreads, prefs.notifications, prefs.archived]);

  // An agent on this computer is waiting for an approval in a thread that isn't open.
  const lastWaiting = useRef<Record<string, number>>({});
  useEffect(() => {
    const n = prefs.notifications;
    for (const m of localThreads) {
      const now = localWaiting[m.id] ?? 0;
      const before = lastWaiting.current[m.id] ?? 0;
      lastWaiting.current[m.id] = now;
      const p = placeRef.current;
      const open = p.view === "thread" && p.selection.id === m.id;
      if (now > before && !open && n.enabled && n.needsInput)
        void notify(m.title || "An agent needs you", "It's waiting for your answer before it carries on.");
    }
  }, [localWaiting, localThreads, prefs.notifications]);

  // ── Local thread metadata updates from the session ───────
  const patchLocal = useCallback((id: string, patch: (m: LocalThreadMeta) => LocalThreadMeta | null) => {
    setLocalThreads(list => {
      let changed = false;
      const next = list.map(m => {
        if (m.id !== id) return m;
        const updated = patch(m);
        if (!updated) return m;
        changed = true;
        return updated;
      });
      return changed ? next : list;
    });
  }, []);

  const onLocalProgress = useCallback(
    (id: string, lastSeq: number) => patchLocal(id, m => (m.lastSeq === lastSeq ? null : { ...m, lastSeq, updatedAt: new Date().toISOString() })),
    [patchLocal],
  );
  const onLocalStatus = useCallback((id: string, status: ThreadStatus) => patchLocal(id, m => (m.status === status ? null : { ...m, status })), [patchLocal]);
  // The thread moved to another agent past a usage limit (its runner keeps that too).
  const onLocalAgent = useCallback(
    (id: string, agent: { kind: AgentKind; model?: string | undefined }) =>
      patchLocal(id, m => {
        if (m.agent.kind === agent.kind && m.agent.model === agent.model) return null;
        return { ...m, agent: { kind: agent.kind, ...(agent.model ? { model: agent.model } : {}) } };
      }),
    [patchLocal],
  );
  const localThreadsRef = useRef(localThreads);
  localThreadsRef.current = localThreads;
  const onSwitchOthers = useCallback(
    (ids: string[], accountId: string) => {
      const metas = localThreadsRef.current.filter(m => ids.includes(m.id)).map(meta => ({ meta, latestSeq: meta.lastSeq ?? 0 }));
      return switchThreadsAccount(metas, settings.runnerPath, accountId);
    },
    [settings.runnerPath],
  );
  const onLocalPromptSent = useCallback(
    (id: string) =>
      patchLocal(id, m => {
        if (m.pendingPrompt === undefined) return null;
        const { pendingPrompt: _sent, ...rest } = m;
        return rest;
      }),
    [patchLocal],
  );

  const onStopLocal = useCallback(async (id: string) => {
    await stopLocalRunner(id);
  }, []);

  const onRemoveLocal = useCallback(
    (id: string) => {
      const meta = localThreads.find(m => m.id === id);
      // Removes the thread's worktree and history; its branch stays in the repository.
      const stop = meta ? removeLocalThread(id, meta.repoPath, settings.runnerPath) : stopLocalRunner(id);
      void stop.catch(err => console.warn("Could not clean up the thread", err)).finally(refreshRunners);
      forgetEvents(id);
      setLocalThreads(list => list.filter(m => m.id !== id));
      go({ view: "home" });
    },
    [refreshRunners, localThreads, settings.runnerPath, go],
  );

  const onArchive = useCallback(
    async (t: ThreadSummary, archive: boolean) => {
      const archived = { ...prefs.archived };
      const wasPinned = prefs.pinned.includes(t.id);
      if (archive) {
        archived[t.id] = new Date().toISOString();
        // Free what it was using: nothing runs for an archived thread.
        if (t.mode === "local") void stopLocalRunner(t.id).finally(refreshRunners);
        // The first time, say what archiving does; Undo puts it back either way.
        const explain = t.mode === "local" && !prefs.archivedHint;
        toast({
          title: `Archived “${t.title}”`,
          ...(explain
            ? { description: "Its agent stopped. Archived threads on this computer are removed after 21 days; their branch stays in your repository." }
            : {}),
          action: {
            label: "Undo",
            onClick: () => {
              const p = prefsRef.current;
              const back = { ...p.archived };
              delete back[t.id];
              onPrefs({ archived: back, ...(wasPinned ? { pinned: [t.id, ...p.pinned.filter(id => id !== t.id)] } : {}) });
            },
          },
          ...(explain ? { timeout: 10_000 } : {}),
        });
        if (explain) onPrefs({ archivedHint: true });
      } else delete archived[t.id];
      onPrefs({ archived, pinned: prefs.pinned.filter(id => id !== t.id) });
    },
    [prefs.archived, prefs.archivedHint, prefs.pinned, onPrefs, refreshRunners],
  );

  // Archived threads on this computer are removed after 21 days (worktree and history; the branch stays).
  const cleanedUp = useRef(false);
  useEffect(() => {
    if (cleanedUp.current || !localThreads.length) return;
    cleanedUp.current = true;
    const cutoff = Date.now() - ARCHIVE_KEEP_DAYS * 86_400_000;
    const old = localThreads.filter(m => prefs.archived[m.id] && Date.parse(prefs.archived[m.id]!) < cutoff);
    for (const m of old) void removeLocalThread(m.id, m.repoPath, settings.runnerPath).catch(err => console.warn("Could not clean up an archived thread", err));
    if (old.length) {
      for (const m of old) forgetEvents(m.id);
      setLocalThreads(list => list.filter(m => !old.some(o => o.id === m.id)));
      const archived = { ...prefs.archived };
      for (const m of old) delete archived[m.id];
      onPrefs({ archived });
    }
  }, [localThreads, prefs.archived, settings.runnerPath, onPrefs]);

  // ── Creating threads ─────────────────────────────────────
  const createThread = async (input: NewThreadInput) => {
    const agent = {
      kind: input.agent,
      ...(input.agentCommand ? { command: input.agentCommand } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    };

    if (input.mode === "local") {
      const id = newThreadId();
      const now = new Date().toISOString();
      const meta: LocalThreadMeta = {
        id,
        title: input.title || (input.prompt ? titleFromPrompt(input.prompt) : repoName(input.repoPath)),
        agent,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: branchForThread(id, isSafeBranchPrefix(settings.branchPrefix) ? settings.branchPrefix : undefined),
        status: "idle",
        lastSeq: 0,
        ...(input.prompt ? { pendingPrompt: input.prompt } : {}),
        createdAt: now,
        updatedAt: now,
      };
      setLocalThreads(list => [meta, ...list]);
      if (prefs.navigateOnCreate) go({ view: "thread", selection: { mode: "local", id } });
      return;
    }

    if (!cloudApi) throw new Error("Connect a cloud account in Settings first.");
    try {
      const created = await cloudApi.createThread({
        ...(input.title || input.prompt ? { title: input.title || titleFromPrompt(input.prompt ?? "") } : {}),
        agent,
        repo: { url: input.repoUrl, baseBranch: input.baseBranch },
        mode: "cloud",
        sandboxSize: input.sandboxSize,
        ...(input.prompt ? { prompt: input.prompt } : {}),
      });
      setCloudThreads(list => [created.thread, ...list.filter(t => t.id !== created.thread.id)]);
      if (prefs.navigateOnCreate) go({ view: "thread", selection: { mode: "cloud", id: created.thread.id } });
    } catch (err) {
      if (err instanceof CloudError && err.denial) throw new DeniedError(err.denial);
      throw err;
    }
  };

  // ── Moving a thread between this computer and the cloud ───
  const moveThread = async (entry: ThreadEntry, from: Connection, onStep: (text: string) => void) => {
    const retry = async <T,>(fn: () => Promise<T>, what: string): Promise<T> => {
      // A new cloud sandbox takes a little while to start; keep trying for a few minutes.
      let last: unknown;
      for (let i = 0; i < 40; i++) {
        try {
          return await fn();
        } catch (err) {
          last = err;
          if (/work of its own|checksum|missing the commit|too big/.test(String(err))) throw err;
          onStep(`${what}…`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      throw last;
    };
    if (entry.mode === "local") {
      if (!cloudApi) throw new Error("Connect LemonLime Cloud in Settings first.");
      const meta = entry.meta;
      const repo = await inspectRepo(meta.repoPath);
      if (!repo.origin) throw new Error("This repository has no remote named origin, so the cloud can't clone it. Push it to GitHub first.");
      onStep("Starting a cloud sandbox…");
      const created = await cloudApi.createThread({
        title: meta.title,
        agent: meta.agent,
        repo: { url: repo.origin, baseBranch: meta.baseBranch },
        mode: "cloud",
        sandboxSize: "small",
      });
      setCloudThreads(list => [created.thread, ...list.filter(t => t.id !== created.thread.id)]);
      const to = await retry(async () => {
        const c = await resolveConnection({ mode: "cloud", thread: created.thread, api: cloudApi });
        if (!c) throw new Error("not up yet");
        return c;
      }, "Waiting for the cloud sandbox");
      onStep("Moving the conversation and commits…");
      await retry(() => teleportThread({ from, to, fromLabel: "computer" }), "Waiting for the cloud sandbox");
      await stopLocalRunner(meta.id).catch(() => undefined);
      onPrefs({ archived: { ...prefs.archived, [meta.id]: new Date().toISOString() } });
      void refreshRunners();
      go({ view: "thread", selection: { mode: "cloud", id: created.thread.id } });
      return;
    }
    const folder = await pickFolder();
    if (!folder) return;
    await inspectRepo(folder);
    const thread = entry.thread;
    const id = newThreadId();
    const now = new Date().toISOString();
    const meta: LocalThreadMeta = {
      id,
      title: thread.title,
      agent: thread.agent,
      repoPath: folder,
      baseBranch: thread.repo.baseBranch,
      branch: branchForThread(id),
      status: "idle",
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    onStep("Starting it on this computer…");
    const to = await resolveConnection({ mode: "local", meta, runnerPath: settings.runnerPath });
    if (!to) throw new Error("Couldn't start the runner on this computer.");
    onStep("Moving the conversation and commits…");
    await teleportThread({ from, to, fromLabel: "cloud" });
    setLocalThreads(list => [meta, ...list]);
    onPrefs({ archived: { ...prefs.archived, [thread.id]: now } });
    await cloudApi?.pauseThread(thread.id).catch(() => undefined);
    void refreshRunners();
    go({ view: "thread", selection: { mode: "local", id } });
  };

  // ── Keyboard shortcuts (Settings → Keyboard can change them) ──
  const shortcutState = useRef({ place, summaries: [] as ThreadSummary[], prefs });
  // One place that runs each shortcut, for the keys and for the command palette.
  const runShortcut = useCallback(
    (id: ShortcutId) => {
      const { place: here, summaries: list, prefs: pr } = shortcutState.current;
      const open = list.filter(t => !pr.archived[t.id]);
      const currentId = here.view === "thread" ? here.selection.id : null;
      const at = open.findIndex(t => t.id === currentId);
      const select = (t: ThreadSummary | undefined) => t && go({ view: "thread", selection: { mode: t.mode, id: t.id } });
      switch (id) {
        case "new-thread":
          return go({ view: "home" });
        case "settings":
          return go({ view: "settings", page: "account" });
        case "search":
          return setPaletteOpen(o => !o);
        case "find":
          if (here.view === "thread") window.dispatchEvent(new Event("lemonlime:find"));
          return;
        case "toggle-sidebar":
          return onPrefs({ sidebarCollapsed: !pr.sidebarCollapsed });
        case "back":
          return setHistory(h => (h.at > 0 ? { ...h, at: h.at - 1 } : h));
        case "forward":
          return setHistory(h => (h.at < h.stack.length - 1 ? { ...h, at: h.at + 1 } : h));
        case "skills":
          return go({ view: "skills" });
        case "automations":
          return go({ view: "automations" });
        case "prev-thread":
          return select(open[at <= 0 ? 0 : at - 1]);
        case "next-thread":
          return select(open[at < 0 ? 0 : Math.min(open.length - 1, at + 1)]);
        case "last-pinned":
          return select(open.find(t => t.id === pr.pinned[0]));
        case "pin-thread":
          if (currentId) onPrefs({ pinned: pr.pinned.includes(currentId) ? pr.pinned.filter(x => x !== currentId) : [currentId, ...pr.pinned] });
          return;
        case "archive-thread": {
          const t = open[at];
          if (t) void onArchiveRef.current(t, true);
          return;
        }
        case "right-panel":
          // A thread has its own panel (changes, terminal, browser); everywhere else, the side panel.
          if (here.view === "thread") return void window.dispatchEvent(new Event("lemonlime:toggle-panel"));
          return togglePanel();
      }
    },
    [go, onPrefs, togglePanel],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e, shortcutState.current.prefs.shortcuts);
      if (!id) return;
      e.preventDefault();
      runShortcut(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runShortcut]);

  // ── Derived lists ────────────────────────────────────────
  const summaries = useMemo(
    () =>
      sortByActivity([
        ...localThreads.map(meta => summarize({ mode: "local", meta }, running.has(meta.id))),
        ...cloudThreads.map(thread => summarize({ mode: "cloud", thread }, true)),
      ]),
    [localThreads, cloudThreads, running],
  );

  shortcutState.current = { place, summaries, prefs };

  // ── Sidebar states: waiting, unread, drafts; the dock badge ──
  const [openWaiting, setOpenWaiting] = useState<Record<string, number>>({});
  const onWaiting = useCallback((id: string, count: number) => setOpenWaiting(w => (w[id] === count ? w : { ...w, [id]: count })), []);
  const [drafts, setDrafts] = useState<Set<string>>(draftThreadIds);
  useEffect(() => {
    const update = () => setDrafts(draftThreadIds());
    window.addEventListener("lemonlime:drafts-changed", update);
    return () => window.removeEventListener("lemonlime:drafts-changed", update);
  }, []);
  // Start keeping track of what was seen; threads from before count as read.
  useEffect(() => {
    if (!prefs.unreadSince) onPrefs({ unreadSince: new Date().toISOString() });
  }, [prefs.unreadSince, onPrefs]);
  const latestSeq = useCallback(
    (t: ThreadSummary) => {
      if (t.mode === "cloud") return cloudThreads.find(c => c.id === t.id)?.latestSeq ?? 0;
      return Math.max(localThreads.find(m => m.id === t.id)?.lastSeq ?? 0, localSeq[t.id] ?? 0);
    },
    [cloudThreads, localThreads, localSeq],
  );
  const selectedId = place.view === "thread" ? place.selection.id : null;
  // Opening a thread clears a hand-made "unread"; while open, what's there counts as seen.
  useEffect(() => {
    if (selectedId && prefsRef.current.markedUnread.includes(selectedId))
      onPrefs({ markedUnread: prefsRef.current.markedUnread.filter(id => id !== selectedId) });
  }, [selectedId, onPrefs]);
  const selectedSummary = selectedId ? summaries.find(t => t.id === selectedId) : undefined;
  const selectedSeq = selectedSummary ? latestSeq(selectedSummary) : 0;
  useEffect(() => {
    if (!selectedId) return;
    const p = prefsRef.current;
    if (p.markedUnread.includes(selectedId) || (p.seenSeq[selectedId] ?? -1) >= selectedSeq) return;
    onPrefs({ seenSeq: { ...p.seenSeq, [selectedId]: selectedSeq } });
  }, [selectedId, selectedSeq, onPrefs]);
  const rowStates = useMemo(() => {
    const glyphs: Record<string, RowGlyph> = {};
    const unread = new Set<string>();
    const waiting: { id: string; waiting: number }[] = [];
    for (const t of summaries) {
      const input = {
        status: t.status,
        // Local runners say how many answers they wait for; the open thread knows for itself.
        waiting: t.mode === "local" ? Math.max(localWaiting[t.id] ?? 0, t.id === selectedId ? (openWaiting[t.id] ?? 0) : 0) : (openWaiting[t.id] ?? 0),
        latestSeq: latestSeq(t),
        seenSeq: prefs.seenSeq[t.id],
        createdAt: t.createdAt,
        unreadSince: prefs.unreadSince,
        markedUnread: prefs.markedUnread.includes(t.id),
        draft: drafts.has(t.id),
        selected: t.id === selectedId,
      };
      glyphs[t.id] = rowGlyph(input);
      if (isUnread(input)) unread.add(t.id);
      waiting.push({ id: t.id, waiting: input.waiting });
    }
    return { glyphs, unread, waiting: waitingCount(waiting, prefs.archived) };
  }, [summaries, localWaiting, openWaiting, latestSeq, prefs.seenSeq, prefs.unreadSince, prefs.markedUnread, prefs.archived, drafts, selectedId]);
  // The dock (macOS) shows how many threads are waiting for you.
  useEffect(() => {
    if (!inDesktopShell()) return;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(rowStates.waiting > 0 ? rowStates.waiting : undefined))
      .catch(err => console.warn("Couldn't set the dock badge", err));
  }, [rowStates.waiting]);
  const onMarkUnread = useCallback(
    (t: ThreadSummary, unread: boolean) => {
      const p = prefsRef.current;
      if (unread) onPrefs({ markedUnread: [...p.markedUnread.filter(id => id !== t.id), t.id] });
      else onPrefs({ markedUnread: p.markedUnread.filter(id => id !== t.id), seenSeq: { ...p.seenSeq, [t.id]: latestSeq(t) } });
    },
    [onPrefs, latestSeq],
  );
  const onRename = useCallback(
    (t: ThreadSummary, title: string) => {
      const clean = title.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!clean) return;
      if (t.mode === "local") {
        patchLocal(t.id, m => (m.title === clean ? null : { ...m, title: clean }));
        return;
      }
      if (!cloudApi) return;
      const before = cloudThreads.find(c => c.id === t.id)?.title ?? "";
      setCloudThreads(list => list.map(c => (c.id === t.id ? { ...c, title: clean } : c)));
      cloudApi.renameThread(t.id, clean).catch(err => {
        setCloudThreads(list => list.map(c => (c.id === t.id ? { ...c, title: before } : c)));
        toast({ title: "Couldn't rename the thread", description: err instanceof Error ? err.message : String(err), tone: "error" });
      });
    },
    [patchLocal, cloudApi, cloudThreads],
  );
  const onArchiveRef = useRef(onArchive);
  onArchiveRef.current = onArchive;

  const selection = place.view === "thread" ? place.selection : null;
  const selectedEntry: ThreadEntry | null = useMemo(() => {
    if (!selection) return null;
    if (selection.mode === "local") {
      const meta = localThreads.find(m => m.id === selection.id);
      return meta ? { mode: "local", meta } : null;
    }
    const thread = cloudThreads.find(t => t.id === selection.id);
    return thread ? { mode: "cloud", thread } : null;
  }, [selection, localThreads, cloudThreads]);

  const saveAll = (s: Settings) => {
    saveSettings(s);
    setSettings(s);
    void saveAccessToken(s.accessToken).catch(err => console.warn("Could not save the access token to the keychain", err));
  };

  const addProject = async () => {
    const folder = await pickFolder().catch(() => null);
    if (!folder) return;
    try {
      await inspectRepo(folder);
      onPrefs({ recentProjects: [folder, ...prefs.recentProjects.filter(p => p !== folder)] });
      go({ view: "home" });
    } catch (err) {
      console.warn("Not a repository", err);
    }
  };

  // ── Command palette (⌘K) ─────────────────────────────────
  const inThread = place.view === "thread";
  const paletteItems = useMemo<PaletteItem[]>(() => {
    if (!paletteOpen) return [];
    const threads = summaries.map<PaletteItem>(t => ({
      id: `thread:${t.id}`,
      section: "threads",
      label: t.title || "Untitled thread",
      detail: `${repoName(t.repo)}${prefs.archived[t.id] ? ", archived" : ""}`,
      keywords: `${t.branch} ${AGENT_LABELS[t.agent.kind]} ${t.mode === "cloud" ? "cloud" : "local"}`,
    }));
    const projects = prefs.recentProjects.map<PaletteItem>(path => ({
      id: `project:${path}`,
      section: "projects",
      label: repoName(path),
      detail: path,
      keywords: "new thread in project",
    }));
    const extras = [
      { id: "plugins", label: "Plugins", keywords: "extensions marketplace install" },
      { id: "add-project", label: "Add a project…", keywords: "folder repository open" },
      ...SETTINGS_PAGES.map(pg => ({ id: `settings:${pg.id}`, label: `Settings: ${pg.label}`, keywords: pg.keywords })),
      { id: "theme:light", label: "Use the light theme", keywords: "appearance colour" },
      { id: "theme:dark", label: "Use the dark theme", keywords: "appearance colour night" },
      { id: "theme:system", label: "Match the system theme", keywords: "appearance colour auto" },
    ];
    // "settings" is the same as Settings: Account; thread commands only make sense in one.
    const skip: ShortcutId[] = ["settings", ...(inThread ? [] : (["pin-thread", "archive-thread", "find"] as const))];
    // Unarchived threads first, as in the sidebar.
    const sortedThreads = [...threads.filter(t => !t.detail?.endsWith(", archived")), ...threads.filter(t => t.detail?.endsWith(", archived"))];
    return [...sortedThreads, ...projects, ...appCommands(extras, skip)];
  }, [paletteOpen, summaries, prefs.recentProjects, prefs.archived, inThread]);

  const runPaletteItem = (item: PaletteItem) => {
    setPaletteRecents(r => rememberPick(r, item.id));
    const [kind, ...rest] = item.id.split(":");
    const value = rest.join(":");
    if (kind === "thread") {
      const t = summaries.find(x => x.id === value);
      if (t) go({ view: "thread", selection: { mode: t.mode, id: t.id } });
      return;
    }
    if (kind === "project") {
      onPrefs({ recentProjects: [value, ...prefs.recentProjects.filter(x => x !== value)] });
      return go({ view: "home" });
    }
    if (value === "plugins") return go({ view: "plugins" });
    if (value === "add-project") return void addProject();
    if (value.startsWith("settings:")) return go({ view: "settings", page: value.slice("settings:".length) as SettingsPage });
    if (value.startsWith("theme:")) return onPrefs({ theme: value.slice("theme:".length) as UiPrefs["theme"] });
    runShortcut(value as ShortcutId);
  };
  const palette = (
    <CommandPalette
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      items={paletteItems}
      recents={paletteRecents}
      onRun={runPaletteItem}
      keysOf={id => keysFor(id, prefs.shortcuts)}
    />
  );

  const settingsCtx: SettingsCtx = {
    settings,
    onSave: saveAll,
    prefs,
    onPrefs,
    justSignedIn: signedIn,
    cloudApi,
    threads: summaries,
    localThreads,
    onUnarchive: t => void onArchive(t, false),
    onOpenThread: t => go({ view: "thread", selection: { mode: t.mode, id: t.id } }),
    agents,
    refreshAgents,
    onSignOut: () => {
      saveAll({ ...settings, accessToken: "", cloudWorkspaceId: "" });
      setSignedIn(false);
    },
    onImported: metas => setLocalThreads(list => mergeImportedThreads(list, { imported: metas.map(thread => ({ id: thread.id, thread, already: false })) })),
    onPage: page => go({ view: "settings", page: page as SettingsPage }),
    onOpenSetup: () => setSetupOpen(true),
  };

  const importChats = (onDone?: () => void, compact = false) => (
    <ImportChats
      runnerPath={settings.runnerPath}
      projects={prefs.recentProjects}
      onImported={settingsCtx.onImported}
      onAddProject={path => onPrefs({ recentProjects: [path, ...prefs.recentProjects.filter(p => p !== path)] })}
      compact={compact}
      {...(onDone ? { onDone } : {})}
    />
  );

  const promptInComposer = (text: string) => {
    setDraft({ text, nonce: Date.now() });
    go({ view: "home" });
  };

  if (setupOpen) {
    return (
      <TipProvider>
        <SetupWizard
          connected={cloudConfigured}
          dashboardUrl={settings.controlPlaneUrl}
          cloudApi={cloudApi}
          prefs={prefs}
          onPrefs={onPrefs}
          agents={agents}
          refreshAgents={refreshAgents}
          macChrome={MAC_CHROME}
          importStep={done => (
            <>
              <h1 className="font-display text-[28px] font-semibold tracking-[-0.03em]">Import your work</h1>
              <p className="mt-2 mb-8 text-[15px] text-ink-soft">
                Bring the chats you've had with your agents into LemonLime, and carry on where you left off.
              </p>
              {importChats(done, true)}
            </>
          )}
          onFinish={() => {
            onPrefs({ setupDone: true });
            setSetupOpen(false);
          }}
        />
      </TipProvider>
    );
  }

  const sidebar =
    place.view === "settings" ? (
      <SettingsSidebar
        page={place.page}
        onPage={page => go({ view: "settings", page })}
        onBack={() => go(selection ? { view: "thread", selection } : { view: "home" })}
      />
    ) : prefs.sidebarCollapsed ? null : (
      <AppSidebar
        threads={summaries}
        currentNav={place.view === "home" ? "new" : place.view === "skills" || place.view === "plugins" || place.view === "automations" ? place.view : null}
        cloudConfigured={cloudConfigured}
        cloudLoading={cloudLoading}
        cloudError={cloudError}
        selectedId={selection?.id ?? null}
        prefs={prefs}
        onPrefs={onPrefs}
        onSelect={(t: ThreadSummary) => go({ view: "thread", selection: { mode: t.mode, id: t.id } })}
        onNew={() => go({ view: "home" })}
        onAutomations={() => go({ view: "automations" })}
        onSkills={() => go({ view: "skills" })}
        onPanel={() => {
          if (place.view === "thread") window.dispatchEvent(new Event("lemonlime:toggle-panel"));
          else togglePanel();
        }}
        panelOpen={panelOpen && place.view !== "thread"}
        onPlugins={() => go({ view: "plugins" })}
        onNewProject={() => void addProject()}
        agentUpdates={agentUpdates}
        onSettings={page => go({ view: "settings", page: (page as SettingsPage) ?? "account" })}
        onBack={back}
        onForward={forward}
        macChrome={MAC_CHROME}
        searchOpen={searchOpen}
        onSearchOpen={setSearchOpen}
        onArchive={onArchive}
        glyphs={rowStates.glyphs}
        unread={rowStates.unread}
        onMarkUnread={onMarkUnread}
        onRename={onRename}
        usageCard={summary ? <UsageCard summary={summary} /> : undefined}
      />
    );

  return (
    <TipProvider>
      <Toaster>
        {palette}
        <div className="flex h-full overflow-hidden">
          {sidebar}
          <div className="relative flex min-w-0 flex-1 flex-col">
            {prefs.sidebarCollapsed && place.view !== "settings" && (
              <button
                type="button"
                aria-label="Show sidebar"
                title="Show sidebar (⌘\)"
                onClick={() => onPrefs({ sidebarCollapsed: false })}
                className={cx(
                  "absolute top-3 z-10 inline-flex size-8 items-center justify-center rounded-full border border-line bg-cream text-ink-soft hover:text-ink",
                  MAC_CHROME ? "left-[84px]" : "left-3",
                )}
              >
                <PanelLeft aria-hidden="true" className="size-4" />
              </button>
            )}
            {update && (
              <div role="status" className="flex items-center gap-3 border-b border-line bg-lime-soft px-6 py-2 text-[14px]">
                <p className="min-w-0 flex-1">LemonLime {update.version} is ready.</p>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={installing}
                  onClick={() => (setInstalling(true), void update.install().catch(() => setInstalling(false)))}
                >
                  {installing ? "Installing…" : "Restart to update"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setUpdate(null)}>
                  Later
                </Button>
              </div>
            )}
            {usage && (
              <div
                role={usage.level === "info" ? "status" : "alert"}
                className={cx(
                  "flex items-center gap-3 border-b px-6 py-2.5 text-[14px]",
                  usage.level === "blocked"
                    ? "border-danger/25 bg-danger-soft"
                    : usage.level === "warning"
                      ? "border-[#f0d95c] bg-lemon-soft"
                      : "border-line bg-cream-deep",
                )}
              >
                <p className="min-w-0 flex-1 text-ink">{usage.message}</p>
                {usage.actionUrl && (
                  <Button size="sm" variant="primary" onClick={() => void openExternal(usage.actionUrl!)}>
                    {usage.actionLabel ?? "Continue"}
                  </Button>
                )}
              </div>
            )}
            <div className="relative flex min-h-0 flex-1">
              <GlobalPanel
                tabs={panelTabs}
                active={panelActive}
                onTabs={setPanelTabs}
                onActive={setPanelActive}
                side={prefs.panelSide}
                onSide={panelSide => onPrefs({ panelSide })}
                onClose={() => setPanelOpen(false)}
                hidden={!panelOpen || place.view === "thread" || place.view === "settings"}
              />
              {place.view === "automations" ? (
                <AutomationsView
                  cloudApi={cloudApi}
                  onConnectCloud={() => go({ view: "settings", page: "account" })}
                  onOpenThread={id => {
                    void refreshCloud();
                    go({ view: "thread", selection: { mode: "cloud", id } });
                  }}
                  scans={<AgentScans runnerPath={settings.runnerPath} />}
                />
              ) : place.view === "skills" ? (
                <SkillsView onPrompt={promptInComposer} />
              ) : place.view === "plugins" ? (
                <PluginsView onPrompt={promptInComposer} />
              ) : place.view === "settings" ? (
                <SettingsView
                  page={place.page}
                  ctx={settingsCtx}
                  importTab={<section className="mb-8 rounded-xl border border-line bg-paper p-5">{importChats()}</section>}
                />
              ) : place.view === "thread" && selectedEntry ? (
                <ThreadView
                  key={`${selectedEntry.mode}:${selection?.id}`}
                  entry={selectedEntry}
                  runnerUp={selectedEntry.mode === "local" && running.has(selectedEntry.meta.id)}
                  runnerPath={settings.runnerPath}
                  cloudApi={cloudApi}
                  onLocalProgress={onLocalProgress}
                  onLocalStatus={onLocalStatus}
                  onLocalPromptSent={onLocalPromptSent}
                  onStopLocal={onStopLocal}
                  onRemoveLocal={onRemoveLocal}
                  onCloudRefresh={refreshCloud}
                  onRunnersChanged={refreshRunners}
                  {...(cloudConfigured || selectedEntry.mode === "cloud" ? { onMove: moveThread } : {})}
                  followUp={prefs.followUp}
                  {...(selectedEntry.mode === "local" && inDesktopShell()
                    ? {
                        onOpenFolder: () => {
                          const m = selectedEntry.meta;
                          void threadFolder(m.repoPath, m.id)
                            .then(dir => openFolder(dir, prefs.editor))
                            .catch(err => console.warn("Couldn't open the thread's folder", err));
                        },
                      }
                    : {})}
                  foldFinished={prefs.collapseFinished}
                  notifyWhenFocused={prefs.notifications.whenFocused}
                  {...(prefs.notifications.enabled && prefs.notifications.needsInput
                    ? { onNeedsInput: (title: string) => void notify(title || "An agent needs you", "It's waiting for your answer before it carries on.") }
                    : {})}
                  onWaiting={onWaiting}
                  agents={agents}
                  onLocalAgent={onLocalAgent}
                  onSwitchOthers={onSwitchOthers}
                  computerLevel={prefs.computerAccess[selectedEntry.mode === "cloud" ? selectedEntry.thread.id : ""] ?? "off"}
                  onComputerLevel={level => {
                    if (selectedEntry.mode !== "cloud") return;
                    const id = selectedEntry.thread.id;
                    // The native side keeps the level, and asks before raising it.
                    void setComputerAccess(id, level).then(now => onPrefs({ computerAccess: { ...prefs.computerAccess, [id]: now } }));
                  }}
                />
              ) : (
                <Home
                  cloudAvailable={cloudConfigured}
                  threadCount={summaries.length}
                  prefs={prefs}
                  onPrefs={onPrefs}
                  onCreate={createThread}
                  onConnectCloud={() => go({ view: "settings", page: "account" })}
                  draft={draft}
                  acpAgents={settings.acpAgents}
                  {...(cloudConfigured && settings.controlPlaneUrl ? { dashboardUrl: settings.controlPlaneUrl } : {})}
                />
              )}
            </div>
          </div>
        </div>
      </Toaster>
    </TipProvider>
  );
}

function sameSet(a: Set<string>, b: string[]): boolean {
  if (a.size !== b.length) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}

/** The deployment's usage card at the foot of the sidebar (cloud hours and the like). */
function UsageCard({ summary }: { summary: { title: string; detail: string; progress?: number; actionUrl?: string; actionLabel?: string } }) {
  return (
    <div className="rounded-xl border border-line bg-paper px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{summary.title}</p>
        {summary.actionUrl && (
          <button type="button" onClick={() => void openExternal(summary.actionUrl!)} className="shrink-0 text-[12.5px] font-medium text-leaf hover:underline">
            {summary.actionLabel ?? "Manage"}
          </button>
        )}
      </div>
      <p className="mt-0.5 truncate text-[12.5px] text-ink-soft">{summary.detail}</p>
      {summary.progress !== undefined && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-cream-deep"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(summary.progress * 100)}
          aria-label={summary.title}
        >
          <div className="h-full rounded-full bg-lime" style={{ width: `${Math.round(summary.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
