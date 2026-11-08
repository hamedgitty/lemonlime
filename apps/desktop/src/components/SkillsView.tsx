import { useCallback, useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  BookOpen,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  GitFork,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { addSkillFromFolder, confirmAction, inDesktopShell, listSkills, removeSkill, skillsFolder, type SkillInfo } from "../lib/native.ts";
import { Markdown, splitFrontMatter } from "../lib/markdown.tsx";
import { forkSkill, readSkill, type SkillDetail, type SkillSource } from "../lib/system.ts";
import {
  SKILLS_SOURCE,
  browseSkills,
  copyName,
  installCatalogSkill,
  readCatalogSkill,
  sizeLabel,
  skillsSourcePage,
  type CatalogSkill,
} from "../lib/skillCatalog.ts";
import { Menu, MenuChoice, MenuItem, MenuLabel, MenuSeparator, PageTabs } from "./primitives.tsx";
import { Button, IconButton, RetryCard, SkeletonRows, SkeletonText, Spinner, TextInput, cx, openExternal, rowFill } from "./ui.tsx";

const SOURCE_LABELS: Record<SkillSource, string> = {
  yours: "Yours",
  bundled: "LemonLime",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  shared: "Shared agent skills",
};

const SOURCE_NOTES: Record<SkillSource, string> = {
  yours: "Copied into every new thread on this computer, for every agent. Sync them to the cloud under Settings → Cloud.",
  bundled: "Comes with LemonLime and is copied into every thread. Turn it off under Settings → Instructions.",
  "claude-code": "Claude Code keeps this one for itself, so only Claude Code sees it. Make it yours to give it to every agent.",
  codex: "Codex keeps this one for itself, so only Codex sees it. Make it yours to give it to every agent.",
  opencode: "OpenCode keeps this one for itself. Make it yours to give it to every agent.",
  shared: "From the shared agent skills folder on this computer. Make it yours to change it here.",
};

/** Starters for "New skill": each becomes a prompt for an agent to write the skill. */
const EXAMPLES: { title: string; what: string }[] = [
  {
    title: "Pull request review",
    what: "reviews a pull request the way I do: correctness first, then tests, then naming and readability, and ends with a short list of must-fix and nice-to-have points",
  },
  {
    title: "Release notes",
    what: "writes release notes from the commits since the last tag, grouped into new, improved and fixed, in plain English for users",
  },
  {
    title: "Debugging an incident",
    what: "works through a production problem: reproduce it, find the first bad change, write down the cause, fix it with a test, and summarise what happened",
  },
  { title: "Writing tests", what: "adds tests for a change in this project's style, covering the edge cases first and running the suite before finishing" },
];

export const skillPrompt = (what: string, dir: string) =>
  `Create a new skill in ${dir || "~/.lemonlime/skills"}: a folder with a SKILL.md (front matter with name and description, then clear steps) that ${what}. Keep it short and specific, and tell me how to use it when you're done.`;

type Item = SkillInfo & { key: string };
type Tab = "installed" | "browse";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SkillsView({ onPrompt }: { onPrompt: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>("installed");
  const [skills, setSkills] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const shell = inDesktopShell();

  const reload = useCallback(
    () =>
      listSkills()
        .then(list => setSkills(list.map(s => ({ ...s, key: `${s.source}:${s.name}` }))))
        .catch(e => setError(String(e))),
    [],
  );
  useEffect(() => {
    void reload();
    void skillsFolder().then(setDir, () => undefined);
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };

  const yours = useMemo(() => new Set((skills ?? []).filter(s => s.source === "yours").map(s => s.name)), [skills]);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line px-6">
        <div data-tauri-drag-region className="flex h-[52px] min-w-0 items-center gap-3 overflow-hidden">
          <h1 className="flex items-center gap-2 font-sans text-[15px] font-semibold tracking-normal">
            <BookOpen aria-hidden="true" className="size-4 text-ink-soft" />
            Skills
          </h1>
          <span className="flex-1" />
          {tab === "installed" && (
            <IconButton label="Refresh" onClick={() => void reload()}>
              <RefreshCw aria-hidden="true" />
            </IconButton>
          )}
          <div className="flex">
            <Button size="sm" variant="primary" className="rounded-r-none" onClick={() => onPrompt(skillPrompt("does what I describe next: ", dir))}>
              <Plus aria-hidden="true" className="size-4" />
              New skill
            </Button>
            <Menu
              align="end"
              trigger={
                <Button size="sm" variant="primary" aria-label="More ways to add a skill" className="rounded-l-none border-l-lemon-seam px-1.5">
                  <ChevronDown aria-hidden="true" className="size-4" />
                </Button>
              }
            >
              <MenuItem icon={<FolderOpen />} disabled={!shell} onSelect={() => void act(addSkillFromFolder)}>
                Add a skill folder…
              </MenuItem>
              <MenuItem icon={<Sparkles />} onSelect={() => onPrompt(skillPrompt("does what I describe next: ", dir))}>
                Write one with an agent
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>Examples</MenuLabel>
              {EXAMPLES.map(e => (
                <MenuItem key={e.title} onSelect={() => onPrompt(skillPrompt(e.what, dir))}>
                  {e.title}
                </MenuItem>
              ))}
            </Menu>
          </div>
        </div>
        <PageTabs
          label="Skills"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "installed", label: "Installed", ...(skills ? { count: skills.length } : {}) },
            { id: "browse", label: "Browse" },
          ]}
        />
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
            <IconButton label="Dismiss" className="-my-1 -mr-1.5" onClick={() => (setError(null), setNotice(null))}>
              <X aria-hidden="true" />
            </IconButton>
          </p>
        </div>
      )}

      {tab === "installed" ? (
        <Installed
          skills={skills}
          shell={shell}
          selected={selected}
          onSelect={setSelected}
          onFork={s => act(async () => setSelected(`yours:${await forkSkill(s.name, s.source)}`))}
          onRemove={s =>
            act(async () => {
              if (await confirmAction(`Remove the ${s.name} skill? New threads won't get it; threads that already have it keep their copy.`)) {
                await removeSkill(s.name);
                setSelected(null);
              }
            })
          }
          onBrowse={() => setTab("browse")}
        />
      ) : (
        <Browse
          yours={yours}
          shell={shell}
          onInstalled={(name, copy) => {
            void reload();
            setError(null);
            setNotice(copy ? `Added your own copy as ${name}. Change it as you like; new threads get it.` : `Installed ${name}. New threads get it.`);
          }}
          onShow={name => {
            setSelected(`yours:${name}`);
            setTab("installed");
          }}
        />
      )}
    </main>
  );
}

const order = (s: SkillSource) => ["yours", "bundled", "claude-code", "codex", "opencode", "shared"].indexOf(s);

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="relative min-w-0 flex-1">
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
      <TextInput
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-8 w-full pl-8 text-[14px]"
      />
    </label>
  );
}

function Installed({
  skills,
  shell,
  selected,
  onSelect,
  onFork,
  onRemove,
  onBrowse,
}: {
  skills: Item[] | null;
  shell: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onFork: (s: Item) => Promise<void>;
  onRemove: (s: Item) => Promise<void>;
  onBrowse: () => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | SkillSource>("all");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? [])
      .filter(s => (source === "all" || s.source === source) && `${s.name} ${s.description}`.toLowerCase().includes(q))
      .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : order(a.source) - order(b.source)));
  }, [skills, query, source]);
  const current = shown.find(s => s.key === selected) ?? shown[0] ?? null;
  const sources = [...new Set((skills ?? []).map(s => s.source))].sort((a, b) => order(a) - order(b));

  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Your skills" className="flex w-[clamp(220px,45%,340px)] shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-1.5 p-3">
          <SearchBox value={query} onChange={setQuery} label="Search skills" />
          <Menu
            align="end"
            trigger={
              <IconButton
                label={source === "all" ? "Show skills from" : `Showing ${SOURCE_LABELS[source]}`}
                className={cx(source !== "all" && "bg-cream-hover text-ink")}
              >
                <ListFilter aria-hidden="true" />
              </IconButton>
            }
          >
            <MenuLabel>Show skills from</MenuLabel>
            <MenuChoice
              value={source}
              onChange={setSource}
              closeOnClick
              options={[
                { value: "all" as const, label: `Everywhere (${skills?.length ?? 0})` },
                ...sources.map(s => ({ value: s, label: `${SOURCE_LABELS[s]} (${skills?.filter(x => x.source === s).length ?? 0})` })),
              ]}
            />
          </Menu>
        </div>
        {source !== "all" && (
          <p className="-mt-1 flex items-center gap-1 px-4 pb-2 text-[13px] text-ink-soft">
            From {SOURCE_LABELS[source]}
            <button type="button" className="text-leaf hover:underline" onClick={() => setSource("all")}>
              Show all
            </button>
          </p>
        )}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {skills === null ? (
            shell ? (
              <SkeletonRows rows={6} label="Loading skills" />
            ) : (
              <p className="px-2 py-2 text-[14px] text-ink-soft">Skills are shown in the desktop app.</p>
            )
          ) : shown.length === 0 ? (
            <p className="px-2 py-2 text-[14px] text-ink-soft">
              {query ? (
                "Nothing matches."
              ) : (
                <>
                  No skills yet.{" "}
                  <button type="button" className="text-leaf hover:underline" onClick={onBrowse}>
                    Browse some to install
                  </button>
                  , or add one with New skill.
                </>
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {shown.map(s => (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => onSelect(s.key)}
                    aria-current={current?.key === s.key ? "true" : undefined}
                    className={cx("flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors duration-100", rowFill(current?.key === s.key))}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{s.name}</span>
                      <span className="shrink-0 text-[12px] text-ink-faint">{SOURCE_LABELS[s.source]}</span>
                    </span>
                    {s.description && <span className="line-clamp-2 text-[13px] text-ink-soft">{s.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Skill" className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        {current ? (
          <SkillPreview key={current.key} skill={current} onFork={() => onFork(current)} onRemove={() => onRemove(current)} />
        ) : skills !== null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <BookOpen aria-hidden="true" className="size-6 text-ink-faint" />
            <p className="max-w-[360px] text-[14px] text-pretty text-ink-soft">
              A skill is a folder with a SKILL.md that tells agents how to do something your way. Pick one to read it.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SkillPreview({ skill, onFork, onRemove }: { skill: Item; onFork: () => Promise<void>; onRemove: () => Promise<void> }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    readSkill(skill.name, skill.source).then(setDetail, e => setError(String(e)));
  }, [skill.name, skill.source]);
  const fm = detail ? splitFrontMatter(detail.content) : null;
  return (
    <article className="mx-auto w-full max-w-[760px] px-6 pt-6 pb-16">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[22px] font-semibold text-balance break-words">{skill.name}</h2>
          <p className="mt-0.5 text-[14px] text-pretty text-ink-soft">{SOURCE_NOTES[skill.source]}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {detail && (
            <Button size="sm" variant="ghost" onClick={() => void revealItemInDir(detail.path)}>
              <FolderOpen aria-hidden="true" className="size-4" />
              Show in folder
            </Button>
          )}
          {skill.source === "yours" ? (
            <Button size="sm" variant="danger" onClick={() => void onRemove()}>
              <Trash2 aria-hidden="true" className="size-4" />
              Remove
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => (setBusy(true), void onFork().finally(() => setBusy(false)))}>
              {busy ? <Spinner /> : <GitFork aria-hidden="true" className="size-4" />}
              Make it yours
            </Button>
          )}
        </div>
      </div>
      {detail && <p className="mt-2 truncate font-mono text-[12px] text-ink-faint">{detail.path}</p>}
      {error && <p className="mt-4 text-[14px] text-danger">{error}</p>}
      {!detail && !error && (
        <div className="mt-6">
          <SkeletonText label="Loading the skill" />
        </div>
      )}
      {fm && fm.fields.length > 0 && (
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-line bg-paper px-4 py-3 text-[14px]">
          {fm.fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-faint">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {fm && (
        <div className="mt-6">
          <Markdown text={fm.body} onLink={url => void openExternal(url)} />
        </div>
      )}
      {detail && detail.files.length > 0 && (
        <section className="mt-8">
          <h3 className="font-sans text-[14px] font-semibold tracking-normal">Also in this skill</h3>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[13px] text-ink-soft">
            {detail.files.map(f => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

// ── Browse: skills from the public repository ───────────────

function Browse({
  yours,
  shell,
  onInstalled,
  onShow,
}: {
  yours: ReadonlySet<string>;
  shell: boolean;
  onInstalled: (name: string, copy: boolean) => void;
  onShow: (name: string) => void;
}) {
  const [list, setList] = useState<CatalogSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback((force = false) => {
    setError(null);
    setLoading(true);
    browseSkills(force)
      .then(setList, e => setError(message(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(), [load]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (list ?? []).filter(s => words.every(w => `${s.name} ${s.description}`.toLowerCase().includes(w)));
  }, [list, query]);
  const current = shown.find(s => s.name === selected) ?? shown[0] ?? null;

  if (error && !list) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <RetryCard title="The skills list didn't load" detail={error} busy={loading} onRetry={() => load(true)} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Skills to install" className="flex w-[clamp(220px,45%,340px)] shrink-0 flex-col border-r border-line">
        <div className="flex flex-col gap-1.5 p-3">
          <SearchBox value={query} onChange={setQuery} label="Search skills to install" />
          <p className="px-1 text-[13px] text-ink-faint">
            From{" "}
            <button type="button" className="inline text-left text-leaf hover:underline" onClick={() => void openExternal(skillsSourcePage())}>
              {SKILLS_SOURCE.label}
            </button>
          </p>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {list === null ? (
            <SkeletonRows rows={7} label="Loading skills to install" />
          ) : shown.length === 0 ? (
            <p className="px-2 py-2 text-[14px] text-ink-soft">Nothing matches.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {shown.map(s => (
                <li key={s.name}>
                  <button
                    type="button"
                    onClick={() => setSelected(s.name)}
                    aria-current={current?.name === s.name ? "true" : undefined}
                    className={cx("flex w-full flex-col rounded-lg px-2.5 py-2 text-left transition-colors duration-100", rowFill(current?.name === s.name))}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{s.name}</span>
                      {yours.has(s.name) && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-leaf">
                          <Check aria-hidden="true" className="size-3.5" />
                          Installed
                        </span>
                      )}
                    </span>
                    {s.description && <span className="line-clamp-2 text-[13px] text-ink-soft">{s.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section aria-label="Skill to install" className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        {current && <CatalogPreview key={current.name} skill={current} yours={yours} shell={shell} onInstalled={onInstalled} onShow={onShow} />}
      </section>
    </div>
  );
}

function CatalogPreview({
  skill,
  yours,
  shell,
  onInstalled,
  onShow,
}: {
  skill: CatalogSkill;
  yours: ReadonlySet<string>;
  shell: boolean;
  onInstalled: (name: string, copy: boolean) => void;
  onShow: (name: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<{ copy: boolean; done: number; total: number } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    readCatalogSkill(skill, ctl.signal).then(setText, e => !ctl.signal.aborted && setError(message(e)));
    return () => ctl.abort();
  }, [skill, attempt]);

  const installed = yours.has(skill.name);
  const install = async (copy: boolean) => {
    const name = copy ? copyName(skill.name, yours) : skill.name;
    setInstallError(null);
    setBusy({ copy, done: 0, total: skill.files.length });
    try {
      await installCatalogSkill(skill, name, (done, total) => setBusy({ copy, done, total }));
      onInstalled(name, copy);
    } catch (e) {
      setInstallError(message(e));
    } finally {
      setBusy(null);
    }
  };
  const fm = text !== null ? splitFrontMatter(text) : null;
  const others = skill.files.length - 1;

  return (
    <article className="mx-auto w-full max-w-[760px] px-6 pt-6 pb-16">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[22px] font-semibold text-balance break-words">{skill.name}</h2>
          <p className="mt-0.5 text-[14px] text-ink-soft">
            {others > 0 ? `SKILL.md and ${others} more ${others === 1 ? "file" : "files"}, ${sizeLabel(skill.size)}` : `One file, ${sizeLabel(skill.size)}`}
            {skill.license && <span className="text-ink-faint">. Licence: {skill.license}</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => void openExternal(skillsSourcePage(skill.name))}>
            <ExternalLink aria-hidden="true" className="size-4" />
            On GitHub
          </Button>
          <Button size="sm" disabled={!shell || busy !== null} onClick={() => void install(true)} title="Adds a renamed copy you can change">
            {busy?.copy ? <Spinner /> : <GitFork aria-hidden="true" className="size-4" />}
            Make my own copy
          </Button>
          {installed ? (
            <Button size="sm" onClick={() => onShow(skill.name)}>
              <Check aria-hidden="true" className="size-4 text-leaf" />
              Installed
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!shell || busy !== null} onClick={() => void install(false)}>
              {busy && !busy.copy ? <Spinner /> : <Download aria-hidden="true" className="size-4" />}
              Install
            </Button>
          )}
        </div>
      </div>
      {busy && (
        <p role="status" className="mt-3 text-[14px] text-ink-soft tabular-nums">
          Downloading {busy.done} of {busy.total} {busy.total === 1 ? "file" : "files"}…
        </p>
      )}
      {!shell && <p className="mt-3 text-[14px] text-ink-faint">Skills install in the LemonLime desktop app.</p>}
      {installError && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[14px] text-ink">
          {installError}
        </p>
      )}
      {skill.description && <p className="mt-5 text-[15px] text-pretty text-ink">{skill.description}</p>}
      <div className="mt-6">
        {error ? (
          <RetryCard title="Its SKILL.md didn't load" detail={error} onRetry={() => setAttempt(a => a + 1)} />
        ) : fm ? (
          <div className="rounded-2xl border border-line bg-paper px-5 py-4">
            <Markdown text={fm.body} onLink={url => void openExternal(url)} />
          </div>
        ) : (
          <SkeletonText label="Loading the skill" />
        )}
      </div>
    </article>
  );
}
