import { useEffect, useMemo, useState } from "react";
import { useSettingsTab } from "../../lib/settingsNav.ts";
import { Cloud, Eye, EyeOff } from "lucide-react";
import { GithubMark } from "../icons.tsx";
import { CloudApi, CloudError, normalizeBaseUrl, type CloudWorkspace } from "../../lib/cloud.ts";
import { AGENT_LABELS } from "../../lib/format.ts";
import { startBrowserSignIn } from "../../lib/desktopAuth.ts";
import { confirmAction, inDesktopShell } from "../../lib/native.ts";
import { Button, Spinner, TextInput, cx, inputClass, openExternal } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { Pill, Row, SavedNote, Section, Select, Tabs, useSaved } from "./parts.tsx";

export function AccountPage({ ctx }: { ctx: SettingsCtx }) {
  const [tab, setTab] = useSettingsTab<"account" | "activity">("account", "account", ["account", "activity"]);
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "account", label: "Account" },
          { id: "activity", label: "Activity" },
        ]}
      />
      {tab === "account" ? <AccountTab key={`${ctx.settings.controlPlaneUrl}|${ctx.settings.accessToken ? 1 : 0}`} ctx={ctx} /> : <ActivityTab ctx={ctx} />}
    </>
  );
}

function AccountTab({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave, justSignedIn } = ctx;
  const [url, setUrl] = useState(settings.controlPlaneUrl);
  const [token, setToken] = useState(settings.accessToken);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string; actionUrl?: string; actionLabel?: string } | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saved, markSaved] = useSaved();
  const validUrl = (value: string) => value.trim() === "" || /^https?:\/\/[^\s]+$/i.test(value.trim());
  const connected = Boolean(settings.controlPlaneUrl && settings.accessToken);

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

  const signOut = async () => {
    if (await confirmAction("Sign out of the cloud on this computer? Cloud agents keep running, and you can sign in again any time.")) ctx.onSignOut();
  };

  return (
    <>
      <div
        className={cx("mb-6 flex items-center gap-3 rounded-xl border px-4 py-3", connected ? "border-lime-line bg-lime-soft" : "border-line bg-cream-deep")}
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
        {connected && (
          <Button size="sm" variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </div>
      {connected && <WorkspacePicker ctx={ctx} />}
      <Connections ctx={ctx} />
      <Section title="Sign in" description="The quickest way: approve this computer in your browser, and LemonLime keeps the sign-in in your system keychain.">
        <Row
          label="Sign in with your browser"
          description={
            justSignedIn ? (
              <span className="text-leaf">Signed in. Cloud threads are connected.</span>
            ) : (
              "Opens your LemonLime dashboard to approve this computer."
            )
          }
        >
          <Button variant="primary" onClick={() => void startBrowserSignIn(url.trim() || "https://app.lemonlime.dev")} disabled={!inDesktopShell()}>
            {connected ? "Sign in again" : "Sign in with your browser"}
          </Button>
        </Row>
      </Section>
      <Section
        title="Cloud connection"
        description="Or connect by hand: your dashboard's address, and a personal access token you create under Settings → Personal access tokens there."
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
            <p role="status" className={test.ok ? "text-[14px] text-leaf" : "text-[14px] text-danger"}>
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
      <Section title="Setup">
        <Row label="Run setup again" description="Sign in, connect an agent and GitHub, and bring in your other chats.">
          <Button onClick={ctx.onOpenSetup}>Open setup</Button>
        </Row>
      </Section>
      {connected && (
        <Section title="Your account">
          <Row label="Manage your account" description="Change your email, see billing, or delete your account in the dashboard.">
            <Button onClick={() => void openExternal(`${settings.controlPlaneUrl}/settings`)}>Open dashboard</Button>
          </Row>
        </Section>
      )}
    </>
  );
}

/** What's connected: cloud, GitHub, and each agent on this computer. */
function Connections({ ctx }: { ctx: SettingsCtx }) {
  const [github, setGithub] = useState<{ id: string; accountLogin: string }[] | null | "loading" | "error">("loading");
  useEffect(() => {
    if (!ctx.cloudApi) return setGithub(null);
    let live = true;
    setGithub("loading");
    ctx.cloudApi.githubInstallations().then(
      list => live && setGithub(list),
      () => live && setGithub("error"),
    );
    return () => {
      live = false;
    };
  }, [ctx.cloudApi]);

  return (
    <Section title="Connected">
      <Row label="Cloud" description={ctx.cloudApi ? "Agents can run in cloud sandboxes." : "Not connected."}>
        <Pill tone={ctx.cloudApi ? "good" : "plain"}>{ctx.cloudApi ? "Connected" : "Off"}</Pill>
      </Row>
      <Row
        label={
          <span className="inline-flex items-center gap-2">
            <GithubMark className="size-4" /> GitHub
          </span>
        }
        description={
          !ctx.cloudApi
            ? "Connect the cloud first, then let LemonLime open pull requests on your repositories."
            : github === "loading"
              ? "Checking…"
              : github === "error"
                ? "Couldn't check."
                : github === null
                  ? "This server has no GitHub App set up."
                  : github.length
                    ? `Connected to ${github.map(g => g.accountLogin).join(", ")}.`
                    : "Not connected yet. Cloud agents can still clone public repositories."
        }
      >
        {ctx.cloudApi && Array.isArray(github) && (
          <Button size="sm" onClick={() => void openExternal(`${ctx.settings.controlPlaneUrl}/settings#github`)}>
            {github.length ? "Manage" : "Connect"}
          </Button>
        )}
      </Row>
      {(ctx.agents ?? []).map(a => (
        <Row
          key={a.kind}
          label={AGENT_LABELS[a.kind]}
          description={
            !a.installed ? "Not installed on this computer." : a.signedIn === false ? "Installed, not signed in." : `Version ${a.version ?? "unknown"}.`
          }
        >
          <Pill tone={!a.installed ? "plain" : a.signedIn === false ? "warn" : "good"}>
            {!a.installed ? "Not installed" : a.signedIn === false ? "Sign in" : a.signedIn ? "Signed in" : "Installed"}
          </Pill>
        </Row>
      ))}
      {ctx.agents && (
        <Row label="Agents" description="Install, update and sign agents in on the Agents page.">
          <Button size="sm" variant="ghost" onClick={() => ctx.onPage("agents")}>
            Open Agents
          </Button>
        </Row>
      )}
    </Section>
  );
}

/** For people in more than one workspace (their own and a team's): which one cloud threads use. */
function WorkspacePicker({ ctx }: { ctx: SettingsCtx }) {
  const { settings, onSave } = ctx;
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[] | null>(null);
  useEffect(() => {
    let live = true;
    new CloudApi({ url: settings.controlPlaneUrl, token: settings.accessToken })
      .listWorkspaces()
      .then(list => live && setWorkspaces(list))
      .catch(() => live && setWorkspaces([]));
    return () => {
      live = false;
    };
  }, [settings.controlPlaneUrl, settings.accessToken]);
  if (!workspaces || workspaces.length < 2) return null;
  const current = workspaces.some(w => w.id === settings.cloudWorkspaceId) ? settings.cloudWorkspaceId : workspaces[0]!.id;
  return (
    <Section title="Workspace" description="Cloud threads, automations, secrets and repositories belong to a workspace. Teammates in the same one share them.">
      <Row label="Work in" htmlFor="cloud-workspace">
        <select
          id="cloud-workspace"
          className={cx(inputClass, "w-[280px]")}
          value={current}
          onChange={e => onSave({ ...settings, cloudWorkspaceId: e.target.value === workspaces[0]!.id ? "" : e.target.value })}
        >
          {workspaces.map(w => (
            <option key={w.id} value={w.id}>
              {w.personal ? `${w.name} (personal)` : w.name}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  );
}

const DAY = 86_400_000;
const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** How you've used LemonLime: threads by agent and place over a period. Worked out here, sent nowhere. */
function ActivityTab({ ctx }: { ctx: SettingsCtx }) {
  const [days, setDays] = useState<"30" | "90" | "365">("30");
  const stats = useMemo(() => {
    const since = Date.now() - Number(days) * DAY;
    const inRange = ctx.threads.filter(t => Date.parse(t.updatedAt) >= since);
    const byAgent = new Map<string, number>();
    const byDay: number[] = Array.from({ length: 7 }, () => 0);
    let local = 0;
    for (const t of inRange) {
      byAgent.set(t.agent.kind, (byAgent.get(t.agent.kind) ?? 0) + 1);
      byDay[new Date(t.updatedAt).getDay()]! += 1;
      if (t.mode === "local") local++;
    }
    const busiest = byDay.some(Boolean) ? WEEKDAYS[byDay.indexOf(Math.max(...byDay))] : null;
    return { total: inRange.length, local, cloud: inRange.length - local, byAgent: [...byAgent.entries()].sort((a, b) => b[1] - a[1]), busiest };
  }, [ctx.threads, days]);
  const max = Math.max(1, ...stats.byAgent.map(([, n]) => n));
  return (
    <>
      <Section
        title="Your activity"
        description="Worked out on this computer from your threads. Nothing is sent anywhere."
        aside={
          <Select
            label="Period"
            value={days}
            onChange={setDays}
            className="w-[150px]"
            options={[
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "365", label: "Last year" },
            ]}
          />
        }
      >
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Threads" value={stats.total} />
          <Stat label="On this computer" value={stats.local} />
          <Stat label="In the cloud" value={stats.cloud} />
        </div>
        {stats.byAgent.length > 0 ? (
          <ul className="flex flex-col gap-2.5">
            {stats.byAgent.map(([kind, n]) => (
              <li key={kind} className="grid grid-cols-[120px_1fr_40px] items-center gap-3 text-[14px]">
                <span>{AGENT_LABELS[kind as keyof typeof AGENT_LABELS] ?? kind}</span>
                <span className="h-2 overflow-hidden rounded-full bg-cream-deep">
                  <span className="block h-full rounded-full bg-lime-2" style={{ width: `${(n / max) * 100}%` }} />
                </span>
                <span className="text-right text-ink-soft tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-ink-soft">No threads in this period yet.</p>
        )}
        {stats.busiest && <p className="text-[14px] text-ink-soft">You start the most threads on {stats.busiest}.</p>}
      </Section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-cream px-3 py-2.5">
      <p className="text-[22px] leading-tight font-semibold tabular-nums">{value}</p>
      <p className="text-[13px] text-ink-soft">{label}</p>
    </div>
  );
}
