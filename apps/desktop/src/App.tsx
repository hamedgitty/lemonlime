import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { branchForThread, newThreadId, type Thread, type ThreadStatus } from "@lemonlime/protocol";
import { AppSidebar } from "./components/AppSidebar.tsx";
import { Home } from "./components/Home.tsx";
import { TipProvider } from "./components/primitives.tsx";
import { SettingsSidebar, SettingsView, type SettingsPage } from "./components/SettingsView.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { Button, cx, openExternal } from "./components/ui.tsx";
import { CloudApi, CloudError, isCloudConfigured } from "./lib/cloud.ts";
import { repoName, titleFromPrompt } from "./lib/format.ts";
import { confirmAction, inDesktopShell, listLocalRunners, loadAccessToken, removeLocalThread, saveAccessToken, stopLocalRunner } from "./lib/native.ts";
import { acceptSignInLink, onSignInLink } from "./lib/desktopAuth.ts";
import { checkForUpdate, type AvailableUpdate } from "./lib/updates.ts";
import { DeniedError, type NewThreadInput } from "./lib/newThread.ts";
import {
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
import { sortByActivity, summarize, type ThreadEntry, type ThreadSummary } from "./lib/threads.ts";

type Selection = { mode: "local" | "cloud"; id: string };
/** Where the app is. Back and forward move through these. */
type Place = { view: "home" } | { view: "thread"; selection: Selection } | { view: "settings"; page: SettingsPage };

const CLOUD_REFRESH_MS = 15_000;
const RUNNER_POLL_MS = 5_000;

/** The macOS app window draws its traffic lights over the sidebar. */
const MAC_CHROME = inDesktopShell() && /Mac/.test(navigator.userAgent);

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

  const onPrefs = useCallback((patch: Partial<UiPrefs>) => {
    setPrefs(p => {
      const next = { ...p, ...patch };
      saveUiPrefs(next);
      return next;
    });
  }, []);

  const cloudConfigured = isCloudConfigured(settings);
  const cloudApi = useMemo(
    () => (cloudConfigured ? new CloudApi({ url: settings.controlPlaneUrl, token: settings.accessToken }) : null),
    [cloudConfigured, settings.controlPlaneUrl, settings.accessToken],
  );

  useEffect(() => saveLocalThreads(localThreads), [localThreads]);

  // ── Local runners ────────────────────────────────────────
  const refreshRunners = useCallback(() => {
    void listLocalRunners()
      .then(ids => setRunning(prev => (sameSet(prev, ids) ? prev : new Set(ids))))
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
  useEffect(() => {
    if (!cloudApi) {
      setUsage(null);
      return;
    }
    const load = () => void cloudApi.usageNotice().then(setUsage, () => setUsage(null));
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, [cloudApi]);

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
        branch: branchForThread(id),
        status: "idle",
        lastSeq: 0,
        ...(input.prompt ? { pendingPrompt: input.prompt } : {}),
        createdAt: now,
        updatedAt: now,
      };
      setLocalThreads(list => [meta, ...list]);
      go({ view: "thread", selection: { mode: "local", id } });
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
      go({ view: "thread", selection: { mode: "cloud", id: created.thread.id } });
    } catch (err) {
      if (err instanceof CloudError && err.denial) throw new DeniedError(err.denial);
      throw err;
    }
  };

  // ── Keyboard shortcuts ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        go({ view: "home" });
      } else if (k === ",") {
        e.preventDefault();
        go({ view: "settings", page: "account" });
      } else if (k === "k") {
        e.preventDefault();
        onPrefs({ sidebarCollapsed: false });
        setSearchOpen(true);
      } else if (k === "\\") {
        e.preventDefault();
        setPrefs(p => {
          const next = { ...p, sidebarCollapsed: !p.sidebarCollapsed };
          saveUiPrefs(next);
          return next;
        });
      } else if (k === "[") {
        e.preventDefault();
        setHistory(h => (h.at > 0 ? { ...h, at: h.at - 1 } : h));
      } else if (k === "]") {
        e.preventDefault();
        setHistory(h => (h.at < h.stack.length - 1 ? { ...h, at: h.at + 1 } : h));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onPrefs]);

  // ── Derived lists ────────────────────────────────────────
  const summaries = useMemo(
    () =>
      sortByActivity([
        ...localThreads.map(meta => summarize({ mode: "local", meta }, running.has(meta.id))),
        ...cloudThreads.map(thread => summarize({ mode: "cloud", thread }, true)),
      ]),
    [localThreads, cloudThreads, running],
  );

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
        cloudConfigured={cloudConfigured}
        cloudLoading={cloudLoading}
        cloudError={cloudError}
        selectedId={selection?.id ?? null}
        prefs={prefs}
        onPrefs={onPrefs}
        onSelect={(t: ThreadSummary) => go({ view: "thread", selection: { mode: t.mode, id: t.id } })}
        onNew={() => go({ view: "home" })}
        onSettings={page => go({ view: "settings", page: (page as SettingsPage) ?? "account" })}
        onBack={back}
        onForward={forward}
        macChrome={MAC_CHROME}
        searchOpen={searchOpen}
        onSearchOpen={setSearchOpen}
      />
    );

  return (
    <TipProvider>
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
          <div className="flex min-h-0 flex-1">
            {place.view === "settings" ? (
              <SettingsView page={place.page} settings={settings} onSave={saveAll} prefs={prefs} onPrefs={onPrefs} justSignedIn={signedIn} />
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
              />
            ) : (
              <Home
                cloudAvailable={cloudConfigured}
                threadCount={summaries.length}
                prefs={prefs}
                onPrefs={onPrefs}
                onCreate={createThread}
                onConnectCloud={() => go({ view: "settings", page: "account" })}
              />
            )}
          </div>
        </div>
      </div>
    </TipProvider>
  );
}

function sameSet(a: Set<string>, b: string[]): boolean {
  if (a.size !== b.length) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}
