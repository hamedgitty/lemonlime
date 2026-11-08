import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, MessageSquarePlus, ExternalLink, FolderOpen, GitBranch, Plus, Puzzle, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Markdown } from "../lib/markdown.tsx";
import { confirmAction, inDesktopShell } from "../lib/native.ts";
import {
  checkPluginUpdates,
  contentsSummary,
  CREATE_PLUGIN_PROMPT,
  filterPlugins,
  gitUrlProblem,
  installPluginFromFolder,
  installPluginFromGit,
  listPlugins,
  pickPluginFolder,
  pluginInitial,
  pluginsFolder,
  readPlugin,
  removePlugin,
  setPluginEnabled,
  updatePlugin,
  type PluginDetail,
  type PluginInstallResult,
  type PluginSummary,
  type PluginTab,
  type PluginUpdateCheck,
} from "../lib/plugins.ts";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Toggle } from "./primitives.tsx";
import { Button, Spinner, TextInput, cx, openExternal } from "./ui.tsx";

export interface PluginsViewProps {
  /** Start a new thread with this prompt (used by the "Create a plugin with an agent" example). */
  onPrompt?: (text: string) => void;
}

type Pane = { kind: "detail"; name: string } | { kind: "git" } | { kind: "none" };

const TABS: Array<{ value: PluginTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "updates", label: "Updates" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/**
 * Plugins: install agent plugins (skills, slash commands, subagents and MCP servers in the
 * widely used plugin layout) from a git repository or a folder, turn them on or off, update
 * and remove them. Enabled plugins are added to every new local thread.
 */
export function PluginsView({ onPrompt }: PluginsViewProps = {}) {
  const shell = inDesktopShell();
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [checks, setChecks] = useState<PluginUpdateCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<PluginTab>("all");
  const [pane, setPane] = useState<Pane>({ kind: "none" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listPlugins();
      setPlugins(list);
      return list;
    } catch (e) {
      setError(message(e));
      setPlugins([]);
      return [];
    }
  }, []);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    try {
      setChecks(await checkPluginUpdates());
    } catch (e) {
      setError(message(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void reload().then(list => {
      if (list.length) setPane(p => (p.kind === "none" ? { kind: "detail", name: list[0]!.name } : p));
      if (list.some(p => p.sourceKind === "git")) void checkUpdates();
    });
  }, [reload, checkUpdates]);

  const updates = useMemo(() => new Set((checks ?? []).filter(c => c.hasUpdate).map(c => c.name)), [checks]);
  const visible = useMemo(() => filterPlugins(plugins ?? [], query, tab, updates), [plugins, query, tab, updates]);

  const afterInstall = async (result: PluginInstallResult) => {
    await reload();
    const names = result.installed.map(p => p.name);
    setPane({ kind: "detail", name: names[0]! });
    const skipped = result.skipped.length ? ` Not installed: ${result.skipped.join(" ")}` : "";
    setNotice(
      names.length === 1
        ? `Installed ${names[0]}. New threads get it.${skipped}`
        : `Installed ${names.length} plugins from this marketplace. They start turned off, so turn on the ones you want.${skipped}`,
    );
  };

  const installFolder = async () => {
    setError(null);
    setNotice(null);
    try {
      const folder = await pickPluginFolder();
      if (folder) await afterInstall(await installPluginFromFolder(folder));
    } catch (e) {
      setError(message(e));
    }
  };

  const toggle = async (p: PluginSummary, enabled: boolean) => {
    setError(null);
    setPlugins(list => list?.map(x => (x.name === p.name ? { ...x, enabled } : x)) ?? null);
    try {
      await setPluginEnabled(p.name, enabled);
    } catch (e) {
      setPlugins(list => list?.map(x => (x.name === p.name ? { ...x, enabled: !enabled } : x)) ?? null);
      setError(message(e));
    }
  };

  const createWithAgent = onPrompt ? () => onPrompt(CREATE_PLUGIN_PROMPT) : undefined;
  const openGit = () => {
    setNotice(null);
    setPane({ kind: "git" });
  };
  const empty = plugins !== null && plugins.length === 0;

  return (
    <main className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <header data-tauri-drag-region className="flex h-[52px] min-w-0 shrink-0 items-center gap-3 overflow-hidden border-b border-line px-6">
        <h1 className="flex items-center gap-2 font-sans text-[15px] font-semibold tracking-normal">
          <Puzzle aria-hidden="true" className="size-4 text-ink-soft" />
          Plugins
        </h1>
        <div className="flex-1" />
        <label className="relative hidden w-full max-w-[240px] min-w-0 @md:block">
          <span className="sr-only">Search plugins</span>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
          <TextInput type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search plugins" className="h-8 pl-9" />
        </label>
        <NewPluginButton disabled={!shell} onGit={openGit} onFolder={() => void installFolder()} onCreate={createWithAgent} />
      </header>

      <div className="flex items-center gap-4 border-b border-line px-6">
        <div role="tablist" aria-label="Show" className="flex gap-1">
          {TABS.map(t => {
            const count = t.value === "updates" ? updates.size : null;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => setTab(t.value)}
                className={cx(
                  "-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2.5 text-[14px] font-medium transition-colors",
                  tab === t.value ? "border-ink text-ink" : "border-transparent text-ink-faint hover:text-ink",
                )}
              >
                {t.label}
                {count ? <span className="rounded-full bg-lemon-soft px-1.5 text-[12px] tabular-nums text-ink">{count}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        {tab === "updates" && (
          <Button size="sm" variant="ghost" disabled={!shell || checking} onClick={() => void checkUpdates()}>
            {checking ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-3.5" />}
            {checking ? "Checking…" : "Check again"}
          </Button>
        )}
      </div>

      {(error || notice) && (
        <div className="px-6 pt-3">
          <p
            role={error ? "alert" : "status"}
            className={cx(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13.5px]",
              error ? "border-danger/20 bg-danger-soft text-ink" : "border-line bg-lime-soft text-ink",
            )}
          >
            <span className="min-w-0 flex-1">{error ?? notice}</span>
            <button type="button" aria-label="Dismiss" className="text-ink-faint hover:text-ink" onClick={() => (error ? setError(null) : setNotice(null))}>
              <X aria-hidden="true" className="size-4" />
            </button>
          </p>
        </div>
      )}

      {empty && pane.kind !== "git" ? (
        <EmptyState shell={shell} onGit={openGit} onFolder={() => void installFolder()} onCreate={createWithAgent} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside aria-label="Installed plugins" className="scroll-thin w-[320px] shrink-0 overflow-y-auto border-r border-line">
            {plugins === null ? (
              <p className="flex items-center gap-2 px-6 py-5 text-[14px] text-ink-soft">
                <Spinner /> Loading…
              </p>
            ) : visible.length === 0 ? (
              <p className="px-6 py-5 text-[14px] text-ink-soft">
                {tab === "updates" ? (checking ? "Checking for updates…" : "Everything is up to date.") : query ? "No plugins match that." : "No plugins yet."}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 p-2">
                {visible.map(p => (
                  <PluginRow
                    key={p.name}
                    plugin={p}
                    selected={pane.kind === "detail" && pane.name === p.name}
                    hasUpdate={updates.has(p.name)}
                    onSelect={() => setPane({ kind: "detail", name: p.name })}
                    onToggle={v => void toggle(p, v)}
                  />
                ))}
              </ul>
            )}
            {tab === "all" && createWithAgent && plugins !== null && (
              <div className="border-t border-line p-4">
                <p className="mb-2 text-[13px] font-medium text-ink-soft">Examples</p>
                <button
                  type="button"
                  onClick={createWithAgent}
                  className="flex w-full items-start gap-3 rounded-xl border border-line bg-paper p-3 text-left transition-colors hover:bg-cream-deep"
                >
                  <MessageSquarePlus aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-leaf" />
                  <span>
                    <span className="block text-[14px] font-medium text-ink">Create a plugin with an agent</span>
                    <span className="block text-[13px] text-ink-faint">Starts a thread that builds one with you.</span>
                  </span>
                </button>
              </div>
            )}
          </aside>
          <section className="scroll-thin min-w-0 flex-1 overflow-y-auto">
            {pane.kind === "git" ? (
              <GitInstallForm
                onCancel={() => setPane(plugins?.[0] ? { kind: "detail", name: plugins[0].name } : { kind: "none" })}
                onInstalled={r => void afterInstall(r)}
              />
            ) : pane.kind === "detail" ? (
              <PluginDetailPane
                key={pane.name}
                name={pane.name}
                summary={plugins?.find(p => p.name === pane.name) ?? null}
                hasUpdate={updates.has(pane.name)}
                onToggle={v => {
                  const p = plugins?.find(x => x.name === pane.name);
                  if (p) void toggle(p, v);
                }}
                onChanged={async text => {
                  setNotice(text);
                  await reload();
                  if (checks) setChecks(c => c?.map(x => (x.name === pane.name ? { ...x, hasUpdate: false } : x)) ?? null);
                }}
                onRemoved={async () => {
                  const list = await reload();
                  setNotice(`Removed ${pane.name}.`);
                  setPane(list[0] ? { kind: "detail", name: list[0].name } : { kind: "none" });
                }}
                onError={setError}
              />
            ) : (
              <p className="px-8 py-10 text-[14px] text-ink-soft">Choose a plugin to see what it gives your agents.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function NewPluginButton({
  disabled,
  onGit,
  onFolder,
  onCreate,
}: {
  disabled: boolean;
  onGit: () => void;
  onFolder: () => void;
  onCreate?: (() => void) | undefined;
}) {
  return (
    <div className="inline-flex">
      <Button variant="primary" className="rounded-r-none" disabled={disabled} onClick={onGit}>
        <Plus aria-hidden="true" className="size-4" />
        New plugin
      </Button>
      <Menu
        align="end"
        trigger={
          <Button variant="primary" aria-label="More ways to add a plugin" className="rounded-l-none border-l-[#d9bd00] px-2" disabled={disabled}>
            <ChevronDown aria-hidden="true" className="size-4" />
          </Button>
        }
      >
        <MenuItem icon={<GitBranch aria-hidden="true" />} onSelect={onGit}>
          Install from Git URL…
        </MenuItem>
        <MenuItem icon={<FolderOpen aria-hidden="true" />} onSelect={onFolder}>
          Install from a folder…
        </MenuItem>
        {onCreate && (
          <>
            <MenuSeparator />
            {/* A group label needs its group around it. */}
            <BaseMenu.Group>
              <MenuLabel>Examples</MenuLabel>
              <MenuItem icon={<MessageSquarePlus aria-hidden="true" />} onSelect={onCreate}>
                Create a plugin with an agent
              </MenuItem>
            </BaseMenu.Group>
          </>
        )}
      </Menu>
    </div>
  );
}

function PluginTile({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex shrink-0 items-center justify-center bg-lemon-soft font-display font-semibold text-ink",
        size === "lg" ? "size-12 rounded-xl text-[20px]" : "size-9 rounded-[10px] text-[15px]",
      )}
    >
      {pluginInitial(name)}
    </span>
  );
}

function PluginRow({
  plugin: p,
  selected,
  hasUpdate,
  onSelect,
  onToggle,
}: {
  plugin: PluginSummary;
  selected: boolean;
  hasUpdate: boolean;
  onSelect: () => void;
  onToggle: (v: boolean) => void;
}) {
  return (
    <li className={cx("flex items-center gap-2 rounded-xl pr-3 transition-colors", selected ? "bg-cream-deep" : "hover:bg-cream-deep/60")}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-xl p-2.5 text-left"
      >
        <PluginTile name={p.name} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[14px] font-medium text-ink">{p.name}</span>
            {p.version && <span className="shrink-0 text-[12.5px] tabular-nums text-ink-faint">{p.version}</span>}
          </span>
          <span className="line-clamp-2 text-[13px] text-ink-faint">
            {p.problem ? "Can't be read. Open it to see why." : p.description || contentsSummary(p.contents)}
          </span>
          {hasUpdate && <span className="mt-1 inline-flex rounded-full bg-lemon-soft px-2 text-[12px] font-medium text-ink">Update available</span>}
        </span>
      </button>
      <Toggle checked={p.enabled} onChange={onToggle} label={`Use ${p.name} in new threads`} />
    </li>
  );
}

function GitInstallForm({ onCancel, onInstalled }: { onCancel: () => void; onInstalled: (r: PluginInstallResult) => void }) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [plugin, setPlugin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = gitUrlProblem(url);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      onInstalled(await installPluginFromGit(url, ref, plugin));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={e => void submit(e)} className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-8 py-10">
      <div>
        <h2 className="font-sans text-[18px] font-semibold tracking-normal">Install from a Git URL</h2>
        <p className="mt-1 text-[14px] text-ink-soft">
          A repository with a <code className="font-mono text-[12.5px] text-ink">.claude-plugin/plugin.json</code>, or a marketplace that lists several plugins.
          For a marketplace, name the plugin you want, or leave it empty to install every plugin it keeps in its own folders.
        </p>
      </div>
      <label className="block">
        <span className="mb-1 block text-[13.5px] font-medium">Repository</span>
        <TextInput
          autoFocus
          required
          className="font-mono text-[13px]"
          placeholder="https://github.com/you/your-plugin"
          value={url}
          onChange={e => setUrl(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>
      <label className="block">
        <span className="mb-1 flex items-baseline gap-2 text-[13.5px] font-medium">
          Branch or tag <span className="font-normal text-ink-faint">Optional</span>
        </span>
        <TextInput className="font-mono text-[13px]" placeholder="main" value={ref} onChange={e => setRef(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 flex items-baseline gap-2 text-[13.5px] font-medium">
          Plugin <span className="font-normal text-ink-faint">Optional, for a marketplace</span>
        </span>
        <TextInput className="font-mono text-[13px]" placeholder="code-review" value={plugin} onChange={e => setPlugin(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="text-[13.5px] text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy && <Spinner />}
          {busy ? "Installing…" : "Install"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EmptyState({ shell, onGit, onFolder, onCreate }: { shell: boolean; onGit: () => void; onFolder: () => void; onCreate?: (() => void) | undefined }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-md text-center">
        <Puzzle aria-hidden="true" className="mx-auto mb-3 size-6 text-leaf" />
        <h2 className="font-sans text-[18px] font-semibold tracking-normal">No plugins yet</h2>
        <p className="mt-2 text-[14px] text-ink-soft">Plugins add skills, slash commands, subagents and MCP servers to the agents in your new threads.</p>
        {shell ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onGit}>
              <GitBranch aria-hidden="true" className="size-4" />
              Install from Git URL…
            </Button>
            <Button onClick={onFolder}>
              <FolderOpen aria-hidden="true" className="size-4" />
              Install from a folder…
            </Button>
            {onCreate && (
              <Button variant="ghost" onClick={onCreate}>
                <MessageSquarePlus aria-hidden="true" className="size-4" />
                Create a plugin with an agent
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-3 text-[13.5px] text-ink-faint">Plugins are managed in the LemonLime desktop app.</p>
        )}
      </div>
    </div>
  );
}

function PluginDetailPane({
  name,
  summary,
  hasUpdate,
  onToggle,
  onChanged,
  onRemoved,
  onError,
}: {
  name: string;
  summary: PluginSummary | null;
  hasUpdate: boolean;
  onToggle: (v: boolean) => void;
  onChanged: (notice: string) => Promise<void>;
  onRemoved: () => Promise<void>;
  onError: (e: string) => void;
}) {
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"update" | "remove" | null>(null);

  const load = useCallback(() => {
    readPlugin(name).then(setDetail, e => setLoadError(message(e)));
  }, [name]);
  useEffect(load, [load]);

  if (loadError) return <p className="px-8 py-10 text-[14px] text-danger">{loadError}</p>;
  if (!detail) {
    return (
      <p className="flex items-center gap-2 px-8 py-10 text-[14px] text-ink-soft">
        <Spinner /> Loading…
      </p>
    );
  }
  const p = { ...detail, enabled: summary?.enabled ?? detail.enabled };
  const c = p.contents;

  const update = async () => {
    setBusy("update");
    try {
      const r = await updatePlugin(name);
      load();
      await onChanged(
        !r.changed
          ? `${name} is already up to date.`
          : r.version && r.version !== r.previousVersion
            ? `Updated ${name} to ${r.version}. New threads get it.`
            : `Updated ${name}. New threads get the new copy.`,
      );
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!(await confirmAction(`Remove ${name}? New threads won't get it, and running threads drop it when they restart.`))) return;
    setBusy("remove");
    try {
      await removePlugin(name);
      await onRemoved();
    } catch (e) {
      onError(message(e));
      setBusy(null);
    }
  };

  return (
    <article className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-8 py-8">
      <div className="flex items-start gap-4">
        <PluginTile name={p.name} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[22px] font-semibold tracking-[-0.015em] break-words">{p.name}</h2>
          {p.description && <p className="mt-1 text-[14px] text-ink-soft">{p.description}</p>}
        </div>
        <label className="flex shrink-0 items-center gap-2 pt-1 text-[13.5px] text-ink-soft">
          {p.enabled ? "On" : "Off"}
          <Toggle checked={p.enabled} onChange={onToggle} label={`Use ${p.name} in new threads`} />
        </label>
      </div>

      {p.problem && (
        <p role="alert" className="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[13.5px]">
          This plugin can't be read, so threads skip it: {p.problem}
        </p>
      )}

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[14px]">
        <Meta label="Source">
          <span className="font-mono text-[13px] break-all">{p.source}</span>
          {p.ref && <span className="text-ink-faint"> on {p.ref}</span>}
        </Meta>
        <Meta label="Version">
          <span className="tabular-nums">{p.version ?? "Not given"}</span>
          {p.commit && <span className="ml-2 font-mono text-[12.5px] text-ink-faint">{p.commit.slice(0, 7)}</span>}
        </Meta>
        {p.author && <Meta label="Author">{p.author}</Meta>}
        {p.license && <Meta label="Licence">{p.license}</Meta>}
        <Meta label="Updated">{shortDate(p.updatedAt)}</Meta>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void update()} disabled={busy !== null} variant={hasUpdate ? "primary" : "secondary"}>
          {busy === "update" ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-4" />}
          {busy === "update" ? "Updating…" : hasUpdate ? "Update now" : "Update"}
        </Button>
        {p.homepage && (
          <Button variant="ghost" onClick={() => void openExternal(p.homepage!)}>
            <ExternalLink aria-hidden="true" className="size-4" />
            Homepage
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() =>
            void pluginsFolder().then(
              dir => revealItemInDir(`${dir}/${p.name}`),
              e => onError(message(e)),
            )
          }
        >
          <FolderOpen aria-hidden="true" className="size-4" />
          Show in folder
        </Button>
        <div className="flex-1" />
        <Button variant="danger" onClick={() => void remove()} disabled={busy !== null}>
          {busy === "remove" ? <Spinner /> : <Trash2 aria-hidden="true" className="size-4" />}
          Remove
        </Button>
      </div>

      <section aria-labelledby="plugin-gives">
        <h3 id="plugin-gives" className="font-sans text-[16px] font-semibold tracking-normal">
          What you get
        </h3>
        <p className="mt-1 text-[13.5px] text-ink-faint">
          Skills reach every agent. Commands and subagents reach Claude Code, MCP servers reach Claude Code and Codex. New threads pick up changes.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Gives title="Skills" items={c.skills} />
          <Gives title="Commands" items={c.commands.map(x => `/${x.split("/").pop()}`)} mono />
          <Gives title="Subagents" items={c.agents} />
          <Gives title="MCP servers" items={c.mcpServers} mono />
        </div>
        {c.hooks.length > 0 && (
          <div className="mt-3 rounded-xl border border-line bg-cream px-4 py-3 text-[13.5px]">
            <p className="font-medium text-ink">Hooks: not applied</p>
            <p className="mt-0.5 text-ink-faint">
              It defines hooks for {c.hooks.join(", ")}. LemonLime doesn't run plugin hooks, because they run commands on every tool call and can approve tools
              on their own.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="plugin-overview">
        <h3 id="plugin-overview" className="font-sans text-[16px] font-semibold tracking-normal">
          Overview
        </h3>
        <div className="mt-3 rounded-2xl border border-line bg-paper px-5 py-4 text-[14px]">
          {p.readme ? <Markdown text={p.readme} onLink={url => void openExternal(url)} /> : <p className="text-ink-faint">This plugin has no README.</p>}
        </div>
      </section>
    </article>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}

function Gives({ title, items, mono }: { title: string; items: string[]; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-paper px-4 py-3">
      <p className="flex items-baseline justify-between text-[14px] font-medium text-ink">
        {title}
        <span className="text-[13px] font-normal tabular-nums text-ink-faint">{items.length}</span>
      </p>
      {items.length ? (
        <ul className={cx("mt-1.5 flex flex-col gap-0.5 text-[13px] text-ink-soft", mono && "font-mono text-[12.5px]")}>
          {items.slice(0, 12).map((i, n) => (
            <li key={`${n}-${i}`} className="truncate" title={i}>
              {i}
            </li>
          ))}
          {items.length > 12 && <li className="font-sans text-ink-faint">and {items.length - 12} more</li>}
        </ul>
      ) : (
        <p className="mt-1.5 text-[13px] text-ink-faint">None</p>
      )}
    </div>
  );
}
