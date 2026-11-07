import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, Laptop, Plus } from "lucide-react";
import { branchForThread, newThreadId, type Thread, type ThreadStatus } from "@lemonlime/protocol";
import { Sidebar } from "./components/Sidebar.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { DeniedError, NewThreadDialog, type NewThreadInput } from "./components/NewThreadDialog.tsx";
import { Button, LogoMark } from "./components/ui.tsx";
import {
  forgetEvents,
  loadLocalThreads,
  loadSettings,
  saveLocalThreads,
  saveSettings,
  type LocalThreadMeta,
  type Settings,
} from "./lib/storage.ts";
import { CloudApi, CloudError, isCloudConfigured } from "./lib/cloud.ts";
import { inDesktopShell, listLocalRunners, removeLocalThread, stopLocalRunner } from "./lib/native.ts";
import { sortByActivity, summarize, type ThreadEntry, type ThreadSummary } from "./lib/threads.ts";
import { repoName, titleFromPrompt } from "./lib/format.ts";

type Selection = { mode: "local" | "cloud"; id: string };
type View = "home" | "thread" | "settings";

const CLOUD_REFRESH_MS = 15_000;
const RUNNER_POLL_MS = 5_000;

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [localThreads, setLocalThreads] = useState<LocalThreadMeta[]>(loadLocalThreads);
  const [cloudThreads, setCloudThreads] = useState<Thread[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [view, setView] = useState<View>("home");
  const [newOpen, setNewOpen] = useState(false);

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
    (id: string, lastSeq: number) =>
      patchLocal(id, m => (m.lastSeq === lastSeq ? null : { ...m, lastSeq, updatedAt: new Date().toISOString() })),
    [patchLocal],
  );
  const onLocalStatus = useCallback(
    (id: string, status: ThreadStatus) => patchLocal(id, m => (m.status === status ? null : { ...m, status })),
    [patchLocal],
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
      setSelection(s => (s?.id === id ? null : s));
      setView(v => (v === "thread" ? "home" : v));
    },
    [refreshRunners, localThreads, settings.runnerPath],
  );

  // ── Creating threads ─────────────────────────────────────
  const createThread = async (input: NewThreadInput) => {
    const agent = {
      kind: input.agent,
      ...(input.agentCommand ? { command: input.agentCommand } : {}),
      ...(input.model ? { model: input.model } : {}),
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
      setSelection({ mode: "local", id });
      setView("thread");
      setNewOpen(false);
      return;
    }

    if (!cloudApi) throw new Error("Connect a control plane in Settings first.");
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
      setSelection({ mode: "cloud", id: created.thread.id });
      setView("thread");
      setNewOpen(false);
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
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewOpen(true);
      } else if (e.key === ",") {
        e.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Derived lists ────────────────────────────────────────
  const localSummaries = useMemo(
    () => sortByActivity(localThreads.map(meta => summarize({ mode: "local", meta }, running.has(meta.id)))),
    [localThreads, running],
  );
  const cloudSummaries = useMemo(
    () => sortByActivity(cloudThreads.map(thread => summarize({ mode: "cloud", thread }, true))),
    [cloudThreads],
  );

  const selectedEntry: ThreadEntry | null = useMemo(() => {
    if (!selection) return null;
    if (selection.mode === "local") {
      const meta = localThreads.find(m => m.id === selection.id);
      return meta ? { mode: "local", meta } : null;
    }
    const thread = cloudThreads.find(t => t.id === selection.id);
    return thread ? { mode: "cloud", thread } : null;
  }, [selection, localThreads, cloudThreads]);

  const select = (t: ThreadSummary) => {
    setSelection({ mode: t.mode, id: t.id });
    setView("thread");
  };

  const saveAll = (s: Settings) => {
    saveSettings(s);
    setSettings(s);
  };

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        local={localSummaries}
        cloud={cloudSummaries}
        cloudConfigured={cloudConfigured}
        cloudLoading={cloudLoading}
        cloudError={cloudError}
        selectedId={view === "thread" ? (selection?.id ?? null) : null}
        settingsOpen={view === "settings"}
        onSelect={select}
        onNew={() => setNewOpen(true)}
        onSettings={() => setView("settings")}
        onRefreshCloud={refreshCloud}
      />

      {view === "settings" ? (
        <SettingsView settings={settings} onSave={saveAll} />
      ) : view === "thread" && selectedEntry ? (
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
        <Home onNew={() => setNewOpen(true)} hasThreads={localThreads.length + cloudThreads.length > 0} />
      )}

      {newOpen && (
        <NewThreadDialog cloudAvailable={cloudConfigured} onCancel={() => setNewOpen(false)} onCreate={createThread} />
      )}
    </div>
  );
}

function Home({ onNew, hasThreads }: { onNew: () => void; hasThreads: boolean }) {
  const shell = inDesktopShell();
  const mod = navigator.userAgent.includes("Mac") ? "Cmd" : "Ctrl";
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-10">
      <div className="flex max-w-[520px] flex-col items-center text-center">
        <LogoMark size={56} />
        <h1 className="mt-6 text-[34px] leading-tight font-semibold text-ink">
          Your coding agents keep working after you close your laptop.
        </h1>
        <p className="mt-3 text-[15px] text-ink-soft">
          Start a thread with Claude Code, Codex, OpenCode or any ACP agent. Each thread works on its own branch, with your own
          model accounts.
        </p>
        <div className="mt-7 flex items-center gap-3">
          <Button variant="primary" onClick={onNew}>
            <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />
            New thread
          </Button>
          <span className="text-[13px] text-ink-faint">or press {mod}+N</span>
        </div>
        <div className="mt-10 grid w-full grid-cols-2 gap-3 text-left">
          <div className="rounded-2xl border border-line bg-white p-4 shadow-panel">
            <Laptop aria-hidden="true" className="size-5 text-leaf" />
            <p className="mt-2 font-medium text-ink">On this computer</p>
            <p className="mt-0.5 text-[13px] text-ink-soft">The agent runs in a repository folder you pick, next to your tools.</p>
          </div>
          <div className="rounded-2xl border border-line bg-white p-4 shadow-panel">
            <Cloud aria-hidden="true" className="size-5 text-leaf" />
            <p className="mt-2 font-medium text-ink">In the cloud</p>
            <p className="mt-0.5 text-[13px] text-ink-soft">An isolated sandbox that pauses itself when the agent is idle.</p>
          </div>
        </div>
        {!shell && (
          <p className="mt-6 rounded-lg bg-lemon-soft px-3 py-2 text-[13px] text-ink">
            You are viewing the app in a browser. Run <span className="font-mono text-[12.5px]">pnpm tauri dev</span> for local threads.
          </p>
        )}
        {hasThreads && <p className="mt-6 text-[13px] text-ink-faint">Pick a thread on the left to continue.</p>}
      </div>
    </main>
  );
}

function sameSet(a: Set<string>, b: string[]): boolean {
  if (a.size !== b.length) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}
