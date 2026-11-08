import { useCallback, useEffect, useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookOpen, ChevronDown, FolderOpen, GitFork, Plus, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { addSkillFromFolder, confirmAction, inDesktopShell, listSkills, removeSkill, skillsFolder, type SkillInfo } from "../lib/native.ts";
import { Markdown, splitFrontMatter } from "../lib/markdown.tsx";
import { forkSkill, readSkill, type SkillDetail, type SkillSource } from "../lib/system.ts";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./primitives.tsx";
import { Button, IconButton, Spinner, TextInput, cx, openExternal } from "./ui.tsx";

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

export function SkillsView({ onPrompt }: { onPrompt: (text: string) => void }) {
  const [skills, setSkills] = useState<Item[] | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | SkillSource>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? [])
      .filter(s => (source === "all" || s.source === source) && `${s.name} ${s.description}`.toLowerCase().includes(q))
      .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : order(a.source) - order(b.source)));
  }, [skills, query, source]);
  const current = shown.find(s => s.key === selected) ?? shown[0] ?? null;
  const sources = [...new Set((skills ?? []).map(s => s.source))].sort((a, b) => order(a) - order(b));

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-6">
        <h1 className="flex items-center gap-2 font-sans text-[15px] font-semibold tracking-normal">
          <BookOpen aria-hidden="true" className="size-4 text-ink-soft" />
          Skills
        </h1>
        <span className="flex-1" />
        <IconButton label="Refresh" onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" className="size-4" />
        </IconButton>
        <div className="flex">
          <Button size="sm" variant="primary" className="rounded-r-none" onClick={() => onPrompt(skillPrompt("does what I describe next: ", dir))}>
            <Plus aria-hidden="true" className="size-4" />
            New skill
          </Button>
          <Menu
            align="end"
            trigger={
              <Button size="sm" variant="primary" aria-label="More ways to add a skill" className="rounded-l-none border-l-[#d8b900] px-1.5">
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
      </header>

      <div className="flex min-h-0 flex-1">
        <section aria-label="Skills" className="flex w-[340px] shrink-0 flex-col border-r border-line">
          <div className="flex flex-col gap-2 p-3">
            <label className="relative">
              <Search aria-hidden="true" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
              <TextInput
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className="w-full pl-8"
              />
            </label>
            <div role="radiogroup" aria-label="Where from" className="flex flex-wrap gap-1">
              {(["all", ...sources] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={source === s}
                  onClick={() => setSource(s)}
                  className={cx(
                    "h-7 rounded-full border px-2.5 text-[12.5px]",
                    source === s ? "border-ink bg-ink text-cream" : "border-line text-ink-soft hover:border-line-strong hover:text-ink",
                  )}
                >
                  {s === "all" ? "All" : SOURCE_LABELS[s]}
                  {s !== "all" && <span className="ml-1 opacity-70">{skills?.filter(x => x.source === s).length}</span>}
                </button>
              ))}
            </div>
          </div>
          <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {skills === null && <li className="px-2 py-2 text-[14px] text-ink-soft">{shell ? "Loading…" : "Skills are shown in the desktop app."}</li>}
            {skills !== null && shown.length === 0 && (
              <li className="px-2 py-2 text-[14px] text-ink-soft">{query ? "Nothing matches." : "No skills yet. Add one with New skill."}</li>
            )}
            {shown.map(s => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setSelected(s.key)}
                  aria-current={current?.key === s.key ? "true" : undefined}
                  className={cx("flex w-full flex-col rounded-lg px-2.5 py-2 text-left", current?.key === s.key ? "bg-cream-hover" : "hover:bg-cream-hover")}
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
        </section>

        <section aria-label="Skill" className="scroll-thin min-w-0 flex-1 overflow-y-auto">
          {error && (
            <p role="alert" className="mx-6 mt-4 rounded-lg bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
              {error}
            </p>
          )}
          {current ? (
            <SkillPreview
              key={current.key}
              skill={current}
              onFork={() => act(async () => setSelected(`yours:${await forkSkill(current.name, current.source)}`))}
              onRemove={() =>
                act(async () => {
                  if (await confirmAction(`Remove the ${current.name} skill? New threads won't get it; threads that already have it keep their copy.`)) {
                    await removeSkill(current.name);
                    setSelected(null);
                  }
                })
              }
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <BookOpen aria-hidden="true" className="size-6 text-ink-faint" />
              <p className="max-w-[360px] text-[14px] text-ink-soft">
                A skill is a folder with a SKILL.md that tells agents how to do something your way. Pick one to read it.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

const order = (s: SkillSource) => ["yours", "bundled", "claude-code", "codex", "opencode", "shared"].indexOf(s);

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
          <h2 className="text-[22px] font-semibold">{skill.name}</h2>
          <p className="mt-0.5 text-[13.5px] text-ink-soft">{SOURCE_NOTES[skill.source]}</p>
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
      {error && <p className="mt-4 text-[13.5px] text-danger">{error}</p>}
      {!detail && !error && <p className="mt-6 text-[14px] text-ink-soft">Loading…</p>}
      {fm && fm.fields.length > 0 && (
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-line bg-paper px-4 py-3 text-[13.5px]">
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
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[12.5px] text-ink-soft">
            {detail.files.map(f => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
