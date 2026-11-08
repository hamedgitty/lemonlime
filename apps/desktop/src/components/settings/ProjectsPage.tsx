import { useMemo, useState, type ReactNode } from "react";
import { useSettingsTab } from "../../lib/settingsNav.ts";
import { ArchiveRestore, ArrowDown, ArrowUp, ExternalLink, FolderGit2, Plus, Search, Trash2 } from "lucide-react";
import type { ThreadEvent } from "@lemonlime/protocol";
import { AGENT_LABELS, relativeTime, repoName } from "../../lib/format.ts";
import { inDesktopShell, inspectRepo, pickFolder } from "../../lib/native.ts";
import { loadEvents } from "../../lib/storage.ts";
import { openFolder, saveTextFile } from "../../lib/system.ts";
import type { ThreadSummary } from "../../lib/threads.ts";
import { Button, IconButton, Spinner, TextInput } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { ErrorText, Row, SavedNote, Section, Select, Tabs, useSaved } from "./parts.tsx";

type Tab = "projects" | "archived" | "import" | "export";

export function ProjectsPage({ ctx, importTab }: { ctx: SettingsCtx; importTab?: ReactNode }) {
  const [tab, setTab] = useSettingsTab<Tab>("projects", "projects", ["projects", "archived", "import", "export"]);
  const archivedCount = ctx.threads.filter(t => ctx.prefs.archived[t.id]).length;
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "projects", label: "Projects", count: ctx.prefs.recentProjects.length },
          { id: "archived", label: "Archived threads", count: archivedCount },
          ...(importTab ? [{ id: "import" as const, label: "Import chats" }] : []),
          { id: "export", label: "Export chats" },
        ]}
      />
      {tab === "projects" && <ProjectsTab ctx={ctx} />}
      {tab === "archived" && <ArchivedTab ctx={ctx} />}
      {tab === "import" && importTab}
      {tab === "export" && <ExportTab ctx={ctx} />}
    </>
  );
}

function ProjectsTab({ ctx }: { ctx: SettingsCtx }) {
  const { prefs, onPrefs } = ctx;
  const [error, setError] = useState<string | null>(null);
  const list = prefs.recentProjects;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of ctx.threads) if (t.mode === "local") m.set(t.repo, (m.get(t.repo) ?? 0) + 1);
    return m;
  }, [ctx.threads]);
  const move = (i: number, by: -1 | 1) => {
    const next = [...list];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onPrefs({ recentProjects: next });
  };
  const add = async () => {
    setError(null);
    try {
      const folder = await pickFolder();
      if (!folder) return;
      await inspectRepo(folder);
      onPrefs({ recentProjects: [folder, ...list.filter(p => p !== folder)] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Section
      title="Projects"
      description="Repository folders on this computer that threads start in, in the order the project picker shows them."
      aside={
        <Button size="sm" onClick={() => void add()} disabled={!inDesktopShell()}>
          <Plus aria-hidden="true" className="size-4" />
          Add a project
        </Button>
      }
    >
      {list.length === 0 && <p className="text-[14px] text-ink-soft">No projects yet. Add a repository folder, or start a thread in one.</p>}
      {list.map((path, i) => (
        <Row
          key={path}
          label={
            <span className="inline-flex items-center gap-2">
              <FolderGit2 aria-hidden="true" className="size-4 text-ink-faint" />
              {repoName(path)}
            </span>
          }
          description={
            <>
              <span className="font-mono text-[13px]">{path}</span>
              {counts.get(path) ? `, ${counts.get(path)} ${counts.get(path) === 1 ? "thread" : "threads"}` : ""}
            </>
          }
        >
          <IconButton label={`Open ${repoName(path)}`} onClick={() => void openFolder(path, ctx.prefs.editor).catch(e => setError(String(e)))}>
            <ExternalLink aria-hidden="true" className="size-4" />
          </IconButton>
          <IconButton label={`Move ${repoName(path)} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            <ArrowUp aria-hidden="true" className="size-4" />
          </IconButton>
          <IconButton label={`Move ${repoName(path)} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
            <ArrowDown aria-hidden="true" className="size-4" />
          </IconButton>
          <IconButton label={`Remove ${repoName(path)} from the list`} onClick={() => onPrefs({ recentProjects: list.filter(p => p !== path) })}>
            <Trash2 aria-hidden="true" className="size-4" />
          </IconButton>
        </Row>
      ))}
      <ErrorText>{error}</ErrorText>
      {list.length > 0 && <p className="text-[13px] text-ink-faint">Removing a project only takes it off this list. Its folder and threads stay.</p>}
    </Section>
  );
}

function ArchivedTab({ ctx }: { ctx: SettingsCtx }) {
  const [query, setQuery] = useState("");
  const [where, setWhere] = useState<"all" | "local" | "cloud">("all");
  const [project, setProject] = useState("all");
  const archived = ctx.threads.filter(t => ctx.prefs.archived[t.id]);
  const projects = [...new Set(archived.map(t => repoName(t.repo)))].sort();
  const shown = archived.filter(
    t =>
      (where === "all" || t.mode === where) &&
      (project === "all" || repoName(t.repo) === project) &&
      `${t.title} ${t.branch}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Section title="Archived threads" description="Threads on this computer are removed 21 days after you archive them; their branch stays in your repository.">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1">
          <Search aria-hidden="true" className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" />
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search archived threads"
            aria-label="Search archived threads"
            className="w-full pl-8"
          />
        </label>
        <Select
          label="Where"
          value={where}
          onChange={setWhere}
          className="w-[150px]"
          options={[
            { value: "all", label: "Everywhere" },
            { value: "local", label: "This computer" },
            { value: "cloud", label: "Cloud" },
          ]}
        />
        <Select
          label="Project"
          value={project}
          onChange={setProject}
          className="w-[170px]"
          options={[{ value: "all", label: "All projects" }, ...projects.map(p => ({ value: p, label: p }))]}
        />
      </div>
      {shown.length === 0 && <p className="text-[14px] text-ink-soft">{archived.length ? "Nothing matches." : "No archived threads."}</p>}
      {shown.map(t => (
        <Row
          key={`${t.mode}:${t.id}`}
          label={t.title}
          description={`${repoName(t.repo)}, ${AGENT_LABELS[t.agent.kind]}, ${t.mode === "cloud" ? "cloud" : "this computer"}, archived ${relativeTime(ctx.prefs.archived[t.id]!)}`}
        >
          <Button size="sm" variant="ghost" onClick={() => ctx.onOpenThread(t)}>
            Open
          </Button>
          <Button size="sm" onClick={() => ctx.onUnarchive(t)}>
            <ArchiveRestore aria-hidden="true" className="size-4" />
            Restore
          </Button>
        </Row>
      ))}
    </Section>
  );
}

const DAY = 86_400_000;

function ExportTab({ ctx }: { ctx: SettingsCtx }) {
  const [where, setWhere] = useState<"all" | "local" | "cloud">("all");
  const [period, setPeriod] = useState("all");
  const [format, setFormat] = useState<"md" | "json">("md");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, markDone] = useSaved();
  const since = period === "all" ? 0 : Date.now() - Number(period) * DAY;
  const picked = ctx.threads.filter(t => (where === "all" || t.mode === where) && Date.parse(t.updatedAt) >= since);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const out: { thread: ThreadSummary; events: ThreadEvent[] }[] = [];
      for (const t of picked) {
        if (t.mode === "local") out.push({ thread: t, events: loadEvents(t.id) });
        else if (ctx.cloudApi) out.push({ thread: t, events: await cloudHistory(ctx, t.id) });
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const content = format === "json" ? JSON.stringify({ exportedAt: new Date().toISOString(), threads: out }, null, 2) : toMarkdown(out);
      if (
        await saveTextFile(
          `lemonlime-chats-${stamp}.${format}`,
          content,
          format === "json" ? { name: "JSON", extensions: ["json"] } : { name: "Markdown", extensions: ["md"] },
        )
      )
        markDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Export chats"
      description="Save your conversations as one file, archived threads included. Messages only; your code is already on its branches."
    >
      <Row label="Threads">
        <Select
          label="Threads"
          value={where}
          onChange={setWhere}
          options={[
            { value: "all", label: "On this computer and in the cloud" },
            { value: "local", label: "On this computer" },
            { value: "cloud", label: "In the cloud" },
          ]}
        />
      </Row>
      <Row label="From">
        <Select
          label="From"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "all", label: "All time" },
            { value: "7", label: "The last 7 days" },
            { value: "30", label: "The last 30 days" },
            { value: "90", label: "The last 90 days" },
          ]}
        />
      </Row>
      <Row label="As">
        <Select
          label="As"
          value={format}
          onChange={setFormat}
          options={[
            { value: "md", label: "Markdown (easy to read)" },
            { value: "json", label: "JSON (everything, for tools)" },
          ]}
        />
      </Row>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button variant="primary" disabled={busy || picked.length === 0 || !inDesktopShell()} onClick={() => void run()}>
          {busy && <Spinner />}
          Export {picked.length} {picked.length === 1 ? "thread" : "threads"}
        </Button>
        <SavedNote show={done} />
      </div>
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

async function cloudHistory(ctx: SettingsCtx, id: string): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  let after = 0;
  for (let page = 0; page < 200; page++) {
    const r = await ctx.cloudApi!.history(id, after);
    events.push(...r.events);
    if (!r.more || r.events.length === 0) break;
    after = r.events[r.events.length - 1]!.seq;
  }
  return events;
}

function toMarkdown(threads: { thread: ThreadSummary; events: ThreadEvent[] }[]): string {
  const parts: string[] = [`# LemonLime chats\n\nExported ${new Date().toLocaleString()}.\n`];
  for (const { thread: t, events } of threads) {
    parts.push(
      `\n---\n\n## ${t.title}\n\n${AGENT_LABELS[t.agent.kind]}, ${repoName(t.repo)}, branch \`${t.branch}\`, ${t.mode === "cloud" ? "cloud" : "this computer"}.\n`,
    );
    for (const e of events) {
      if (e.type === "user_message") parts.push(`\n**You** (${new Date(e.at).toLocaleString()})\n\n${e.text}\n`);
      else if (e.type === "agent_message") parts.push(`\n**${AGENT_LABELS[t.agent.kind]}**\n\n${e.text}\n`);
      else if (e.type === "tool_call") parts.push(`\n> Used ${e.name}\n`);
      else if (e.type === "error") parts.push(`\n> Error: ${e.message}\n`);
    }
  }
  return parts.join("");
}
