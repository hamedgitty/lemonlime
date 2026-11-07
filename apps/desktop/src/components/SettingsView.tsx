import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, Check, Cloud, Eye, EyeOff, Keyboard, Package, Palette, Search, Settings as SettingsIcon, UserRound } from "lucide-react";
import { CloudApi, CloudError, normalizeBaseUrl } from "../lib/cloud.ts";
import { AGENT_LABELS } from "../lib/format.ts";
import { inDesktopShell } from "../lib/native.ts";
import { NAV_ITEMS, type Settings, type UiPrefs } from "../lib/storage.ts";
import { Kbd, Toggle } from "./primitives.tsx";
import { Button, SegmentedControl, Spinner, TextInput, cx, openExternal } from "./ui.tsx";

export type SettingsPage = "account" | "general" | "agents" | "appearance" | "keyboard" | "updates";

const PAGES: { id: SettingsPage; label: string; icon: typeof UserRound; keywords: string }[] = [
  { id: "account", label: "Account", icon: UserRound, keywords: "cloud control plane url token sign in connect" },
  { id: "general", label: "General", icon: SettingsIcon, keywords: "runner binary path local" },
  { id: "agents", label: "Agents", icon: Bot, keywords: "claude codex opencode acp version sign in update" },
  { id: "appearance", label: "Appearance", icon: Palette, keywords: "sidebar organize sort search pinned" },
  { id: "keyboard", label: "Keyboard", icon: Keyboard, keywords: "shortcuts keys" },
  { id: "updates", label: "Updates", icon: Package, keywords: "version release changelog" },
];

/** Agent CLI versions LemonLime is tested with (kept in step with the runner's TESTED_AGENTS). */
const TESTED: { kind: "claude-code" | "codex" | "opencode"; version: string; signIn: string; update: string }[] = [
  { kind: "claude-code", version: "2.1.302", signIn: "claude auth login", update: "claude update" },
  { kind: "codex", version: "0.167.0", signIn: "codex login", update: "codex update" },
  { kind: "opencode", version: "1.18.18", signIn: "opencode auth login", update: "opencode upgrade" },
];

const SHORTCUTS: [string, string][] = [
  ["⌘ N", "New thread"],
  ["⌘ K", "Search threads"],
  ["⌘ ,", "Settings"],
  ["⌘ \\", "Show or hide the sidebar"],
  ["⌘ [", "Back"],
  ["⌘ ]", "Forward"],
  ["Enter", "Send"],
  ["Shift Enter", "New line"],
  ["Esc", "Stop the agent, or leave Settings"],
  ["/", "Search settings"],
];

/** The sidebar while Settings is open: back to the app, search, and the sections. */
export function SettingsSidebar({ page, onPage, onBack }: { page: SettingsPage; onPage: (p: SettingsPage) => void; onBack: () => void }) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? PAGES.filter(p => `${p.label} ${p.keywords}`.toLowerCase().includes(q)) : PAGES;
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Escape" && !typing) {
        e.preventDefault();
        onBack();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <nav aria-label="Settings" className="flex w-[288px] shrink-0 flex-col border-r border-line bg-cream-deep">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="px-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-[14px] font-medium hover:bg-cream-hover"
        >
          <ArrowLeft aria-hidden="true" className="size-4 text-leaf" />
          <span className="flex-1 text-left">Back to app</span>
          <Kbd>Esc</Kbd>
        </button>
      </div>
      <div className="mx-3 my-3 h-px bg-line" />
      <div className="px-2">
        <label className="flex h-[34px] items-center gap-2 rounded-lg border border-line-strong bg-paper px-2.5 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-leaf">
          <Search aria-hidden="true" className="size-3.5 text-ink-faint" />
          <input
            ref={search}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && visible[0]) onPage(visible[0].id);
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-faint"
          />
          <Kbd>/</Kbd>
        </label>
      </div>
      <ul className="mt-3 flex flex-col gap-px px-2">
        {visible.map(p => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPage(p.id)}
              aria-current={page === p.id ? "page" : undefined}
              className={cx(
                "flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[14px] hover:bg-cream-hover",
                page === p.id && "bg-cream-hover",
              )}
            >
              <p.icon aria-hidden="true" className="size-4 text-ink-soft" />
              {p.label}
            </button>
          </li>
        ))}
        {visible.length === 0 && <li className="px-2 py-1.5 text-[13.5px] text-ink-faint">Nothing matches "{query}"</li>}
      </ul>
    </nav>
  );
}

export function SettingsView({
  page,
  settings,
  onSave,
  prefs,
  onPrefs,
}: {
  page: SettingsPage;
  settings: Settings;
  onSave: (s: Settings) => void;
  prefs: UiPrefs;
  onPrefs: (p: Partial<UiPrefs>) => void;
}) {
  const current = PAGES.find(p => p.id === page)!;
  return (
    <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
      <header data-tauri-drag-region className="flex h-[52px] items-center border-b border-line px-6">
        <h1 className="font-sans text-[15px] font-semibold tracking-normal">Settings</h1>
      </header>
      <div className="mx-auto w-full max-w-[740px] px-6 pt-7 pb-16">
        <h2 className="mb-5 flex items-center gap-2.5 text-[22px] font-semibold">
          <current.icon aria-hidden="true" className="size-5 text-ink-soft" />
          {current.label}
        </h2>
        {page === "account" && <AccountPage settings={settings} onSave={onSave} />}
        {page === "general" && <GeneralPage settings={settings} onSave={onSave} />}
        {page === "agents" && <AgentsPage />}
        {page === "appearance" && <AppearancePage prefs={prefs} onPrefs={onPrefs} />}
        {page === "keyboard" && <KeyboardPage />}
        {page === "updates" && <UpdatesPage />}
      </div>
    </main>
  );
}

// ── Building blocks ──────────────────────────────────────────

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="font-sans text-[15px] font-semibold tracking-normal">{title}</h3>
      {description && <p className="mt-0.5 text-[13.5px] text-ink-soft">{description}</p>}
      <div className="mt-3 flex flex-col gap-5 rounded-xl border border-line bg-paper p-5">{children}</div>
    </section>
  );
}

function Row({ label, description, htmlFor, children }: { label: string; description?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      <div className="min-w-0 flex-1 basis-[240px]">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[15px] text-ink">
            {label}
          </label>
        ) : (
          <p className="text-[15px] text-ink">{label}</p>
        )}
        {description && <p className="mt-0.5 text-[13.5px] text-ink-soft">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function SavedNote({ show }: { show: boolean }) {
  return show ? (
    <span role="status" className="inline-flex items-center gap-1.5 text-[13.5px] text-leaf">
      <Check aria-hidden="true" className="size-4" />
      Saved
    </span>
  ) : null;
}

function useSaved(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    saved,
    () => {
      setSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    },
  ];
}

// ── Pages ────────────────────────────────────────────────────

function AccountPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [url, setUrl] = useState(settings.controlPlaneUrl);
  const [token, setToken] = useState(settings.accessToken);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string; actionUrl?: string; actionLabel?: string } | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saved, markSaved] = useSaved();
  const validUrl = (value: string) => value.trim() === "" || /^https?:\/\/[^\s]+$/i.test(value.trim());

  const save = () => {
    if (!validUrl(url)) return setUrlError("Use a full URL starting with http:// or https://");
    setUrlError(null);
    onSave({ ...settings, controlPlaneUrl: url.trim() ? normalizeBaseUrl(url) : "", accessToken: token.trim() });
    markSaved();
  };

  const testConnection = async () => {
    if (!url.trim() || !validUrl(url)) return setUrlError("Use a full URL starting with http:// or https://");
    setUrlError(null);
    setTesting(true);
    setTest(null);
    try {
      const threads = await new CloudApi({ url, token: token.trim() }).listThreads();
      setTest({ ok: true, message: `Connected. ${threads.length === 1 ? "1 cloud thread" : `${threads.length} cloud threads`} found.` });
    } catch (err) {
      if (err instanceof CloudError && err.denial) {
        setTest({
          ok: false,
          message: err.denial.reason,
          ...(err.denial.actionUrl ? { actionUrl: err.denial.actionUrl } : {}),
          ...(err.denial.actionLabel ? { actionLabel: err.denial.actionLabel } : {}),
        });
      } else setTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const connected = Boolean(settings.controlPlaneUrl && settings.accessToken);
  return (
    <>
      <div
        className={cx("mb-6 flex items-center gap-3 rounded-xl border px-4 py-3", connected ? "border-[#cfe9a6] bg-lime-soft" : "border-line bg-cream-deep")}
      >
        <Cloud aria-hidden="true" className={cx("size-5", connected ? "text-leaf" : "text-ink-faint")} />
        <p className="min-w-0 flex-1 text-[14px]">
          {connected ? (
            <>
              Cloud threads are connected to <span className="font-mono text-[13px]">{settings.controlPlaneUrl}</span>
            </>
          ) : (
            "Only threads on this computer. Connect a LemonLime account to run agents in the cloud, where they keep working when you close your laptop."
          )}
        </p>
      </div>
      <Section
        title="Cloud connection"
        description="Your LemonLime dashboard's address, and a personal access token you create under Settings → Personal access tokens there."
      >
        <Row
          label="Dashboard address"
          htmlFor="cp-url"
          description={urlError ? <span className="text-danger">{urlError}</span> : "For example https://app.lemonlime.dev, or your own server."}
        >
          <TextInput
            id="cp-url"
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://app.lemonlime.dev"
            autoComplete="off"
            spellCheck={false}
            className="w-[280px]"
          />
        </Row>
        <Row label="Access token" htmlFor="cp-token" description="Kept in your system keychain, never in plain files.">
          <div className="relative">
            <TextInput
              id="cp-token"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="Paste a token"
              className="w-[280px] pr-10 font-mono text-[13px]"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowToken(s => !s)}
              aria-label={showToken ? "Hide token" : "Show token"}
              aria-pressed={showToken}
              className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint hover:bg-ink/5 hover:text-ink"
            >
              {showToken ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </button>
          </div>
        </Row>
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="primary" onClick={save}>
            Save
          </Button>
          <Button onClick={testConnection} disabled={testing || !url.trim()}>
            {testing && <Spinner />}
            Test connection
          </Button>
          <SavedNote show={saved} />
          {test && (
            <p role="status" className={test.ok ? "text-[13.5px] text-leaf" : "text-[13.5px] text-danger"}>
              {test.message}
              {test.actionUrl && (
                <>
                  {" "}
                  <button type="button" onClick={() => void openExternal(test.actionUrl!)} className="font-medium text-ink underline underline-offset-2">
                    {test.actionLabel || "Learn more"}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </Section>
    </>
  );
}

function GeneralPage({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [runnerPath, setRunnerPath] = useState(settings.runnerPath);
  const [saved, markSaved] = useSaved();
  return (
    <Section
      title="Threads on this computer"
      description="Each local thread works in its own copy of your repository (a git worktree), so your branch and unsaved work are never touched."
    >
      <Row label="Runner" htmlFor="runner-path" description="Leave empty to use the runner that comes with LemonLime, or lemonlime-runner on your PATH.">
        <TextInput
          id="runner-path"
          value={runnerPath}
          onChange={e => setRunnerPath(e.target.value)}
          placeholder="lemonlime-runner"
          className="w-[280px] font-mono text-[13px]"
          autoComplete="off"
          spellCheck={false}
        />
      </Row>
      {!inDesktopShell() && (
        <p className="rounded-lg bg-lemon-soft px-3 py-2 text-[13.5px]">
          You're viewing LemonLime in a browser. Threads on this computer only run inside the desktop app.
        </p>
      )}
      <div className="flex items-center gap-3 border-t border-line pt-4">
        <Button
          variant="primary"
          onClick={() => {
            onSave({ ...settings, runnerPath: runnerPath.trim() });
            markSaved();
          }}
        >
          Save
        </Button>
        <SavedNote show={saved} />
      </div>
    </Section>
  );
}

function AgentsPage() {
  return (
    <Section
      title="Supported agents"
      description="Agents run with your own account. Sign each one in once on this computer; in the cloud, LemonLime signs it in for you."
    >
      {TESTED.map(a => (
        <Row
          key={a.kind}
          label={AGENT_LABELS[a.kind]}
          description={
            <>
              Tested with version {a.version}. Sign in with <code className="font-mono text-[12.5px] text-ink">{a.signIn}</code>, update with{" "}
              <code className="font-mono text-[12.5px] text-ink">{a.update}</code>.
            </>
          }
        >
          <span className="inline-flex h-6 items-center rounded-full bg-lime-soft px-2.5 text-[12.5px] font-medium text-leaf-deep">Supported</span>
        </Row>
      ))}
      <Row
        label="Other ACP agents"
        description="Any agent that speaks the Agent Client Protocol. Choose it in the agent picker and enter the command that starts it."
      >
        <span className="inline-flex h-6 items-center rounded-full bg-cream-deep px-2.5 text-[12.5px] font-medium text-ink-soft">Bring your own</span>
      </Row>
    </Section>
  );
}

function AppearancePage({ prefs, onPrefs }: { prefs: UiPrefs; onPrefs: (p: Partial<UiPrefs>) => void }) {
  return (
    <>
      <Section title="Sidebar">
        {NAV_ITEMS.map(item => (
          <Row
            key={item}
            label={item === "new" ? "Show New thread" : "Show Search threads"}
            description={item === "search" ? "Search is always one ⌘K away." : undefined}
          >
            <Toggle
              label={item === "new" ? "Show New thread" : "Show Search threads"}
              checked={!prefs.hiddenNav.includes(item)}
              onChange={on => onPrefs({ hiddenNav: on ? prefs.hiddenNav.filter(x => x !== item) : [...prefs.hiddenNav, item] })}
            />
          </Row>
        ))}
      </Section>
      <Section title="Threads list">
        <Row label="Group threads">
          <SegmentedControl
            label="Group threads"
            value={prefs.organize}
            onChange={organize => onPrefs({ organize })}
            options={[
              { value: "project", label: "Project" },
              { value: "place", label: "Where" },
              { value: "agent", label: "Agent" },
            ]}
          />
        </Row>
        <Row label="Sort threads">
          <SegmentedControl
            label="Sort threads"
            value={prefs.sort}
            onChange={sort => onPrefs({ sort })}
            options={[
              { value: "recent", label: "Recent" },
              { value: "name", label: "Name" },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

function KeyboardPage() {
  return (
    <Section title="Shortcuts">
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-3">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="contents">
            <dt className="text-[15px]">{what}</dt>
            <dd className="flex gap-1">
              {keys.split(" ").map(k => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function UpdatesPage() {
  return (
    <Section title="LemonLime" description="New versions are announced on GitHub with what changed.">
      <Row label="Version" description="The version of this app.">
        <span className="font-mono text-[13.5px]">{import.meta.env.VITE_APP_VERSION ?? "0.1.0"}</span>
      </Row>
      <Row label="What's new">
        <Button onClick={() => void openExternal("https://github.com/hamedgitty/lemonlime/releases")}>Open releases</Button>
      </Row>
    </Section>
  );
}
