import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  ListFilter,
  MessageSquarePlus,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
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
  type PluginUpdateCheck,
} from "../lib/plugins.ts";
import {
  OFFICIAL_MARKETPLACE,
  browsePlugins,
  catalogDetail,
  categoryLabel,
  groupByCategory,
  installedFrom,
  loadInstallAliases,
  rememberInstallAlias,
  searchCatalog,
  type CatalogDetail,
  type CatalogPlugin,
} from "../lib/pluginCatalog.ts";
import { Menu, MenuChoice, MenuItem, MenuLabel, MenuSeparator, PageTabs, Toggle } from "./primitives.tsx";
import { HideListButton, ListColumn } from "./ListColumn.tsx";
import { Button, IconButton, RetryCard, Skeleton, SkeletonRows, SkeletonText, Spinner, TextInput, cx, openExternal, rowFill } from "./ui.tsx";

export interface PluginsViewProps {
  /** Start a new thread with this prompt (used by the "Create a plugin with an agent" example). */
  onPrompt?: (text: string) => void;
}

type Tab = "browse" | "installed" | "updates";
type Pane = { kind: "detail"; name: string } | { kind: "git" } | { kind: "none" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/**
 * Plugins: browse the official plugin directory and install from it, or install agent
 * plugins (skills, slash commands, subagents and MCP servers in the widely used plugin
 * layout) from any git repository or folder; turn them on or off, update and remove them.
 * Enabled plugins are added to every new local thread.
 */
export function PluginsView({ onPrompt }: PluginsViewProps = {}) {
  const shell = inDesktopShell();
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [checks, setChecks] = useState<PluginUpdateCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);
  const [pane, setPane] = useState<Pane>({ kind: "none" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aliases, setAliases] = useState(loadInstallAliases);

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
      // With nothing installed yet, start on the directory.
      setTab(t => t ?? (list.length ? "installed" : "browse"));
      if (list.length) setPane(p => (p.kind === "none" ? { kind: "detail", name: list[0]!.name } : p));
      if (list.some(p => p.sourceKind === "git")) void checkUpdates();
    });
  }, [reload, checkUpdates]);

  const updates = useMemo(() => new Set((checks ?? []).filter(c => c.hasUpdate).map(c => c.name)), [checks]);
  const visible = useMemo(() => filterPlugins(plugins ?? [], query, tab === "updates" ? "updates" : "installed", updates), [plugins, query, tab, updates]);

  const afterInstall = async (result: PluginInstallResult, fromCatalog?: string) => {
    await reload();
    const names = result.installed.map(p => p.name);
    if (fromCatalog && names[0]) setAliases(rememberInstallAlias(fromCatalog, names[0]));
    if (!fromCatalog) {
      setTab("installed");
      setPane({ kind: "detail", name: names[0]! });
    }
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
    setTab(t => (t === "browse" ? "installed" : t));
    setPane({ kind: "git" });
  };
  const empty = plugins !== null && plugins.length === 0;
  const shownTab = tab ?? "installed";

  return (
    <main className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line px-6 pl-[max(1.5rem,var(--chrome-inset,0px))]">
        <div data-tauri-drag-region className="flex h-[52px] min-w-0 items-center gap-3 overflow-hidden">
          <h1 className="flex items-center gap-2 font-sans text-[15px] font-semibold tracking-normal">
            <Puzzle aria-hidden="true" className="size-4 text-ink-soft" />
            Plugins
          </h1>
          <div className="flex-1" />
          <NewPluginButton disabled={!shell} onGit={openGit} onFolder={() => void installFolder()} onCreate={createWithAgent} />
        </div>
        <div className="flex items-center gap-3">
          <PageTabs
            label="Plugins"
            value={shownTab}
            onChange={setTab}
            tabs={[
              { id: "browse", label: "Browse" },
              { id: "installed", label: "Installed", ...(plugins ? { count: plugins.length } : {}) },
              { id: "updates", label: "Updates", ...(updates.size ? { count: updates.size, attention: true } : {}) },
            ]}
          />
          <div className="flex-1" />
          {shownTab === "updates" && (
            <Button size="sm" variant="ghost" disabled={!shell || checking} onClick={() => void checkUpdates()}>
              {checking ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-3.5" />}
              {checking ? "Checking…" : "Check again"}
            </Button>
          )}
        </div>
      </header>

      {(error || notice) && (
        <div className="px-6 pt-3">
          <p
            role={error ? "alert" : "status"}
            className={cx(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-[14px] text-ink",
              error ? "border-danger/20 bg-danger-soft" : "border-line bg-lime-soft",
            )}
          >
            <span className="min-w-0 flex-1">{error ?? notice}</span>
            <IconButton label="Dismiss" className="-my-1 -mr-1.5" onClick={() => (error ? setError(null) : setNotice(null))}>
              <X aria-hidden="true" />
            </IconButton>
          </p>
        </div>
      )}

      {tab === "browse" ? (
        <Catalogue
          installed={plugins ?? []}
          aliases={aliases}
          shell={shell}
          onInstall={async p => {
            setError(null);
            setNotice(null);
            await afterInstall(await installPluginFromGit(OFFICIAL_MARKETPLACE.url, undefined, p.name), p.name);
          }}
          onRemove={async (p, installedName) => {
            if (!(await confirmAction(`Remove ${installedName}? New threads won't get it, and running threads drop it when they restart.`))) return;
            setError(null);
            await removePlugin(installedName);
            await reload();
            setNotice(`Removed ${p.title}.`);
          }}
          onToggle={(p, v) => void toggle(p, v)}
          onOpenInstalled={name => {
            setTab("installed");
            setPane({ kind: "detail", name });
          }}
        />
      ) : empty && pane.kind !== "git" ? (
        <EmptyState shell={shell} onBrowse={() => setTab("browse")} onGit={openGit} onFolder={() => void installFolder()} onCreate={createWithAgent} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ListColumn label="Installed plugins" as="aside">
            <div className="flex items-center gap-1.5 p-3">
              <SearchBox value={query} onChange={setQuery} label="Search installed plugins" />
              <HideListButton />
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {plugins === null ? (
                <SkeletonRows rows={5} tile label="Loading plugins" />
              ) : visible.length === 0 ? (
                <p className="px-5 py-3 text-[14px] text-ink-soft">
                  {shownTab === "updates"
                    ? checking
                      ? "Checking for updates…"
                      : "Everything is up to date."
                    : query
                      ? "No plugins match that."
                      : "No plugins yet."}
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5 px-2 pb-2">
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
              {shownTab === "installed" && createWithAgent && plugins !== null && (
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
            </div>
          </ListColumn>
          <section className="@container scroll-thin min-w-0 flex-1 overflow-y-auto">
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

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="relative block min-w-0 flex-1">
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
      <TextInput type="search" value={value} onChange={e => onChange(e.target.value)} placeholder={label} aria-label={label} className="h-8 pl-8 text-[14px]" />
    </label>
  );
}

// ── The official directory ──────────────────────────────────

function Catalogue({
  installed,
  aliases,
  shell,
  onInstall,
  onRemove,
  onToggle,
  onOpenInstalled,
}: {
  installed: PluginSummary[];
  aliases: Record<string, string>;
  shell: boolean;
  onInstall: (p: CatalogPlugin) => Promise<void>;
  onRemove: (p: CatalogPlugin, installedName: string) => Promise<void>;
  onToggle: (p: PluginSummary, v: boolean) => void;
  onOpenInstalled: (name: string) => void;
}) {
  const [list, setList] = useState<CatalogPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback((force = false) => {
    setError(null);
    setLoading(true);
    browsePlugins(force)
      .then(setList, e => setError(message(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);

  const categories = useMemo(() => groupByCategory(list ?? []).map(g => ({ id: g.category, n: g.plugins.length })), [list]);
  const groups = useMemo(() => groupByCategory(searchCatalog(list ?? [], query, category)), [list, query, category]);
  const flat = groups.flatMap(g => g.plugins);
  const current = flat.find(p => p.name === selected) ?? flat[0] ?? null;

  if (error && !list) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <RetryCard title="The plugin directory didn't load" detail={error} busy={loading} onRetry={() => load(true)} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ListColumn label="Plugins to install" as="aside">
        <div className="flex flex-col gap-1.5 p-3">
          <div className="flex items-center gap-1.5">
            <SearchBox value={query} onChange={setQuery} label="Search the directory" />
            <Menu
              align="end"
              trigger={
                <IconButton
                  label={category === "all" ? "Show a category" : `Showing ${categoryLabel(category)}`}
                  className={cx(category !== "all" && "bg-cream-hover text-ink")}
                >
                  <ListFilter aria-hidden="true" />
                </IconButton>
              }
            >
              <MenuLabel>Category</MenuLabel>
              <MenuChoice
                value={category}
                onChange={setCategory}
                closeOnClick
                options={[
                  { value: "all", label: `Every category (${list?.length ?? 0})` },
                  ...categories.map(c => ({ value: c.id, label: `${categoryLabel(c.id)} (${c.n})` })),
                ]}
              />
            </Menu>
            <HideListButton />
          </div>
          <p className="px-1 text-[13px] text-ink-faint">
            {category !== "all" ? (
              <>
                {categoryLabel(category)} only.{" "}
                <button type="button" className="text-leaf hover:underline" onClick={() => setCategory("all")}>
                  Show all
                </button>
              </>
            ) : (
              <>
                From{" "}
                <button type="button" className="inline text-left text-leaf hover:underline" onClick={() => void openExternal(OFFICIAL_MARKETPLACE.url)}>
                  {OFFICIAL_MARKETPLACE.label}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2">
          {list === null ? (
            <SkeletonRows rows={8} tile label="Loading the plugin directory" />
          ) : flat.length === 0 ? (
            <p className="px-5 py-3 text-[14px] text-ink-soft">No plugins match that.</p>
          ) : (
            groups.map(g => (
              <section key={g.category} aria-label={categoryLabel(g.category)}>
                <h2 className="sticky top-0 z-10 bg-cream px-5 pt-3 pb-1 font-sans text-[13px] font-medium tracking-normal text-ink-faint">
                  {categoryLabel(g.category)} <span className="tabular-nums">{g.plugins.length}</span>
                </h2>
                <ul className="flex flex-col gap-0.5 px-2">
                  {g.plugins.map(p => {
                    const mine = installedFrom(p, installed, aliases);
                    return (
                      <li key={p.name}>
                        <button
                          type="button"
                          onClick={() => setSelected(p.name)}
                          aria-current={current?.name === p.name ? "true" : undefined}
                          className={cx(
                            "flex w-full items-start gap-3 rounded-xl p-2.5 text-left transition-colors duration-100",
                            rowFill(current?.name === p.name),
                          )}
                        >
                          <PluginTile name={p.title} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{p.title}</span>
                              {mine && (
                                <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-leaf">
                                  <Check aria-hidden="true" className="size-3.5" />
                                  Installed
                                </span>
                              )}
                            </span>
                            <span className="line-clamp-2 text-[13px] text-ink-faint">{p.description}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </ListColumn>
      <section className="@container scroll-thin min-w-0 flex-1 overflow-y-auto">
        {current && (
          <CatalogPane
            key={current.name}
            plugin={current}
            mine={installedFrom(current, installed, aliases)}
            shell={shell}
            onInstall={() => onInstall(current)}
            onRemove={name => onRemove(current, name)}
            onToggle={onToggle}
            onOpenInstalled={onOpenInstalled}
          />
        )}
      </section>
    </div>
  );
}

function CatalogPane({
  plugin: p,
  mine,
  shell,
  onInstall,
  onRemove,
  onToggle,
  onOpenInstalled,
}: {
  plugin: CatalogPlugin;
  mine: PluginSummary | null;
  shell: boolean;
  onInstall: () => Promise<void>;
  onRemove: (installedName: string) => Promise<void>;
  onToggle: (p: PluginSummary, v: boolean) => void;
  onOpenInstalled: (name: string) => void;
}) {
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<"install" | "remove" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetailError(null);
    catalogDetail(p).then(
      d => live && setDetail(d),
      e => live && setDetailError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [p, attempt]);

  const run = async (what: "install" | "remove", fn: () => Promise<void>) => {
    setBusy(what);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const c = detail?.contents;

  return (
    <article className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-8 py-8">
      <div className="flex items-start gap-4">
        <PluginTile name={p.title} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[22px] font-semibold tracking-[-0.015em] text-balance break-words">{p.title}</h2>
          <p className="mt-0.5 text-[14px] text-ink-soft">
            {p.author && `By ${p.author}. `}
            <span className="text-ink-faint">{categoryLabel(p.category)}</span>
          </p>
        </div>
        {mine && (
          <label className="flex shrink-0 items-center gap-2 pt-1 text-[14px] text-ink-soft">
            {mine.enabled ? "On" : "Off"}
            <Toggle checked={mine.enabled} onChange={v => onToggle(mine, v)} label={`Use ${mine.name} in new threads`} />
          </label>
        )}
      </div>

      {p.description && <p className="-mt-2 text-[15px] text-pretty text-ink">{p.description}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {mine ? (
          <>
            <Button onClick={() => onOpenInstalled(mine.name)}>
              <Check aria-hidden="true" className="size-4 text-leaf" />
              Installed
            </Button>
            <Button variant="danger" disabled={busy !== null} onClick={() => void run("remove", () => onRemove(mine.name))}>
              {busy === "remove" ? <Spinner /> : <Trash2 aria-hidden="true" className="size-4" />}
              Remove
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={!shell || !p.installable || busy !== null} onClick={() => void run("install", onInstall)}>
            {busy === "install" ? <Spinner /> : <Download aria-hidden="true" className="size-4" />}
            {busy === "install" ? "Installing…" : "Install"}
          </Button>
        )}
        {p.homepage && (
          <Button variant="ghost" onClick={() => void openExternal(p.homepage!)}>
            <ExternalLink aria-hidden="true" className="size-4" />
            Homepage
          </Button>
        )}
      </div>
      {!p.installable && (
        <p className="-mt-3 text-[14px] text-ink-soft">This one is set up by running a program on your computer, which LemonLime doesn't do.</p>
      )}
      {!shell && <p className="-mt-3 text-[14px] text-ink-faint">Plugins install in the LemonLime desktop app.</p>}
      {actionError && (
        <p role="alert" className="-mt-3 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[14px] text-ink">
          {actionError}
        </p>
      )}

      <section aria-labelledby="catalog-gives">
        <h3 id="catalog-gives" className="font-sans text-[16px] font-semibold tracking-normal">
          What it adds
        </h3>
        {detailError ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-paper px-4 py-3 text-[14px]">
            <span className="min-w-0 flex-1 text-ink-soft">Its files couldn't be looked at just now. {detailError}</span>
            {p.where.kind === "github" && (
              <Button size="sm" onClick={() => setAttempt(a => a + 1)}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-3 @lg:grid-cols-2">
              <GivesOrSkeleton title="Commands" items={c?.commands.map(x => `/${x.split("/").pop()}`)} mono />
              <GivesOrSkeleton title="Subagents" items={c?.agents} />
              <GivesOrSkeleton title="Skills" items={c?.skills} />
              <GivesOrSkeleton title="MCP servers" items={c?.mcpServers} mono />
              {p.lspServers.length > 0 && <Gives title="Language servers" items={p.lspServers} mono />}
            </div>
            {c?.hooks && (
              <div className="mt-3 rounded-xl border border-line bg-cream px-4 py-3 text-[14px]">
                <p className="font-medium text-ink">Hooks: not applied</p>
                <p className="mt-0.5 text-ink-faint">It defines hooks. LemonLime doesn't run plugin hooks, because they run commands on every tool call.</p>
              </div>
            )}
            {c?.partial && <p className="mt-2 text-[13px] text-ink-faint">Its repository is very large, so this list may be missing some.</p>}
          </>
        )}
      </section>

      {(detail?.readme || (!detail && !detailError)) && (
        <section aria-labelledby="catalog-overview">
          <h3 id="catalog-overview" className="font-sans text-[16px] font-semibold tracking-normal">
            Overview
          </h3>
          <div className="mt-3 rounded-2xl border border-line bg-paper px-5 py-4 text-[14px]">
            {detail?.readme ? <Markdown text={detail.readme} onLink={url => void openExternal(url)} /> : <SkeletonText label="Loading its README" />}
          </div>
        </section>
      )}
    </article>
  );
}

function GivesOrSkeleton({ title, items, mono }: { title: string; items: string[] | undefined; mono?: boolean }) {
  if (items) return <Gives title={title} items={items} {...(mono ? { mono } : {})} />;
  return (
    <div className="rounded-xl border border-line bg-paper px-4 py-3">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </div>
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
          <Button variant="primary" aria-label="More ways to add a plugin" className="rounded-l-none border-l-lemon-seam px-2" disabled={disabled}>
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
    <li className={cx("flex items-center gap-2 rounded-xl pr-3 transition-colors duration-100", rowFill(selected))}>
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
            {p.version && <span className="shrink-0 text-[13px] tabular-nums text-ink-faint">{p.version}</span>}
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
          A repository with a <code className="font-mono text-[13px] text-ink">.claude-plugin/plugin.json</code>, or a marketplace that lists several plugins.
          For a marketplace, name the plugin you want, or leave it empty to install every plugin it keeps in its own folders.
        </p>
      </div>
      <label className="block">
        <span className="mb-1 block text-[14px] font-medium">Repository</span>
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
        <span className="mb-1 flex items-baseline gap-2 text-[14px] font-medium">
          Branch or tag <span className="font-normal text-ink-faint">Optional</span>
        </span>
        <TextInput className="font-mono text-[13px]" placeholder="main" value={ref} onChange={e => setRef(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 flex items-baseline gap-2 text-[14px] font-medium">
          Plugin <span className="font-normal text-ink-faint">Optional, for a marketplace</span>
        </span>
        <TextInput className="font-mono text-[13px]" placeholder="code-review" value={plugin} onChange={e => setPlugin(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="text-[14px] text-danger">
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

function EmptyState({
  shell,
  onBrowse,
  onGit,
  onFolder,
  onCreate,
}: {
  shell: boolean;
  onBrowse: () => void;
  onGit: () => void;
  onFolder: () => void;
  onCreate?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-md text-center">
        <Puzzle aria-hidden="true" className="mx-auto mb-3 size-6 text-leaf" />
        <h2 className="font-sans text-[18px] font-semibold tracking-normal">No plugins yet</h2>
        <p className="mt-2 text-[14px] text-ink-soft">Plugins add skills, slash commands, subagents and MCP servers to the agents in your new threads.</p>
        {shell ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={onBrowse}>
              <Puzzle aria-hidden="true" className="size-4" />
              Browse the directory
            </Button>
            <Button onClick={onGit}>
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
          <p className="mt-3 text-[14px] text-ink-faint">Plugins are managed in the LemonLime desktop app.</p>
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
      <div className="mx-auto w-full max-w-[760px] px-8 py-8">
        <SkeletonText label="Loading the plugin" />
      </div>
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
        <label className="flex shrink-0 items-center gap-2 pt-1 text-[14px] text-ink-soft">
          {p.enabled ? "On" : "Off"}
          <Toggle checked={p.enabled} onChange={onToggle} label={`Use ${p.name} in new threads`} />
        </label>
      </div>

      {p.problem && (
        <p role="alert" className="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[14px]">
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
          {p.commit && <span className="ml-2 font-mono text-[13px] text-ink-faint">{p.commit.slice(0, 7)}</span>}
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
        <p className="mt-1 text-[14px] text-ink-faint">
          Skills reach every agent. Commands and subagents reach Claude Code, MCP servers reach Claude Code and Codex. New threads pick up changes.
        </p>
        <div className="mt-3 grid gap-3 @lg:grid-cols-2">
          <Gives title="Skills" items={c.skills} />
          <Gives title="Commands" items={c.commands.map(x => `/${x.split("/").pop()}`)} mono />
          <Gives title="Subagents" items={c.agents} />
          <Gives title="MCP servers" items={c.mcpServers} mono />
        </div>
        {c.hooks.length > 0 && (
          <div className="mt-3 rounded-xl border border-line bg-cream px-4 py-3 text-[14px]">
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
        <ul className={cx("mt-1.5 flex flex-col gap-0.5 text-[13px] text-ink-soft", mono && "font-mono text-[13px]")}>
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
