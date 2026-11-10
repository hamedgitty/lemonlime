import { useEffect, useState, type ReactNode } from "react";
import { AgentIcon } from "./AgentIcon.tsx";
import { Check, Cloud, Copy, RefreshCw, X } from "lucide-react";
import { GithubMark } from "./icons.tsx";
import type { CloudApi } from "../lib/cloud.ts";
import { startBrowserSignIn } from "../lib/desktopAuth.ts";
import { AGENT_LABELS } from "../lib/format.ts";
import { inDesktopShell } from "../lib/native.ts";
import type { UiPrefs } from "../lib/storage.ts";
import { installAgent, TESTED_AGENTS, type AgentInstall } from "../lib/system.ts";
import { Button, LogoMark, Spinner, cx, openExternal } from "./ui.tsx";

type Step = "signin" | "agent" | "github" | "import";

export interface SetupWizardProps {
  connected: boolean;
  dashboardUrl: string;
  cloudApi: CloudApi | null;
  prefs: UiPrefs;
  onPrefs: (p: Partial<UiPrefs>) => void;
  agents: AgentInstall[] | null;
  refreshAgents: () => void;
  onFinish: () => void;
  /** The "Import your work" step, when this build can read other agents' chats. */
  importStep?: (done: () => void) => ReactNode;
  macChrome: boolean;
}

/** First run, and any time from Account: four steps to being set up. Every step can be skipped. */
export function SetupWizard(p: SetupWizardProps) {
  const steps: { id: Step; title: string }[] = [
    { id: "signin", title: "Sign in" },
    { id: "agent", title: "Connect an agent" },
    { id: "github", title: "Connect GitHub" },
    ...(p.importStep ? [{ id: "import" as const, title: "Import your work" }] : []),
  ];
  const [step, setStep] = useState<Step>("signin");
  const [done, setDone] = useState<Set<Step>>(new Set());
  const at = steps.findIndex(s => s.id === step);
  const next = () => {
    setDone(d => new Set(d).add(step));
    if (at + 1 < steps.length) setStep(steps[at + 1]!.id);
    else p.onFinish();
  };
  const agentReady = (p.agents ?? []).some(a => a.installed && a.signedIn !== false);
  const status = (id: Step): string => {
    if (id === "signin") return p.connected ? "Connected" : step === id ? "In progress" : done.has(id) ? "Skipped" : "";
    if (id === "agent") return agentReady ? `${AGENT_LABELS[p.prefs.lastAgent]} ready` : step === id ? "In progress" : "";
    return done.has(id) ? "Done" : step === id ? "In progress" : "";
  };

  return (
    <div className="flex h-full w-full bg-cream">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-cream-deep px-5 pb-6">
        <div data-tauri-drag-region className={cx("h-[52px] shrink-0", p.macChrome && "pl-[70px]")} />
        <div className="flex items-center gap-2.5">
          <LogoMark size={26} />
          <span className="font-display text-[18px] font-semibold tracking-[-0.02em]">LemonLime</span>
        </div>
        <ol className="mt-8 flex flex-col gap-1">
          {steps.map((s, i) => {
            const isDone = done.has(s.id) || (s.id === "signin" && p.connected) || (s.id === "agent" && agentReady);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setStep(s.id)}
                  aria-current={step === s.id ? "step" : undefined}
                  className={cx("flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left", step === s.id ? "bg-cream-hover" : "hover:bg-cream-hover")}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
                      isDone ? "bg-lime text-on-citrus" : step === s.id ? "bg-ink text-cream" : "border border-line-strong text-ink-soft",
                    )}
                  >
                    {isDone ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium">{s.title}</span>
                    {status(s.id) && <span className="block truncate text-[13px] text-ink-soft">{status(s.id)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <span className="flex-1" />
        <p className="text-[13px] text-ink-soft">You can open this again from Settings → Account.</p>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end px-5">
          <button type="button" onClick={p.onFinish} className="inline-flex items-center gap-1.5 text-[14px] text-ink-soft hover:text-ink">
            Skip setup
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[560px] px-6 pt-[8vh] pb-16">
            {step === "signin" && <SignInStep {...p} onNext={next} />}
            {step === "agent" && <AgentStep {...p} onNext={next} ready={agentReady} />}
            {step === "github" && <GithubStep {...p} onNext={next} />}
            {step === "import" && p.importStep?.(next)}
          </div>
        </div>
      </main>
    </div>
  );
}

function Heading({ title, body }: { title: string; body: ReactNode }) {
  return (
    <>
      <h1 className="font-display text-[28px] font-semibold tracking-[-0.03em]">{title}</h1>
      <p className="mt-2 text-[15px] text-ink-soft">{body}</p>
    </>
  );
}

function SignInStep({ connected, dashboardUrl, onNext }: SetupWizardProps & { onNext: () => void }) {
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (connected) setWaiting(false);
  }, [connected]);
  return (
    <>
      <Heading
        title="Sign in to LemonLime"
        body="So agents can run in the cloud and keep working when you close your laptop. Threads on this computer work without an account."
      />
      <div className="mt-8 rounded-2xl border border-line bg-paper p-5 shadow-panel">
        {connected ? (
          <div className="flex items-center gap-3">
            <Cloud aria-hidden="true" className="size-5 text-leaf" />
            <p className="flex-1 text-[15px]">You're signed in. Cloud threads are connected.</p>
            <Button variant="primary" onClick={onNext}>
              Continue
            </Button>
          </div>
        ) : waiting ? (
          <div className="flex items-center gap-3">
            <Spinner className="text-leaf" />
            <p className="flex-1 text-[15px]">Waiting for your browser… Approve this computer there.</p>
            <Button variant="ghost" onClick={() => setWaiting(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              disabled={!inDesktopShell()}
              onClick={() => {
                setWaiting(true);
                void startBrowserSignIn(dashboardUrl || "https://app.lemonlime.dev");
              }}
            >
              Sign in with your browser
            </Button>
            <Button variant="ghost" onClick={onNext}>
              Not now, just this computer
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function AgentStep({ agents, refreshAgents, prefs, onPrefs, onNext, ready }: SetupWizardProps & { onNext: () => void; ready: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const install = async (kind: AgentInstall["kind"]) => {
    setBusy(kind);
    setError(null);
    try {
      await installAgent(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      refreshAgents();
    }
  };
  return (
    <>
      <Heading title="Connect an agent" body="LemonLime runs the agents you already use, with your own plan or API key. Pick the one to start with." />
      <ul className="mt-8 flex flex-col gap-2.5">
        {TESTED_AGENTS.map(t => {
          const a = agents?.find(x => x.kind === t.kind);
          const chosen = prefs.lastAgent === t.kind;
          return (
            <li key={t.kind} className={cx("rounded-2xl border bg-paper p-4", chosen ? "border-ink" : "border-line")}>
              <div className="flex items-center gap-3">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="radio"
                    name="default-agent"
                    checked={chosen}
                    onChange={() => onPrefs({ lastAgent: t.kind })}
                    className="size-4 accent-[var(--color-leaf)]"
                  />
                  <AgentIcon kind={t.kind} color className="size-5" />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium">{AGENT_LABELS[t.kind]}</span>
                    <span className="block text-[13px] text-ink-soft">
                      {!a
                        ? agents === null
                          ? "Looking on this computer…"
                          : "Shown in the desktop app."
                        : !a.installed
                          ? "Not on this computer yet."
                          : a.signedIn === false
                            ? `Found, version ${a.version ?? "unknown"}. Sign in once.`
                            : `Found on this computer${a.version ? `, version ${a.version}` : ""}.`}
                    </span>
                  </span>
                </label>
                {a && !a.installed && (
                  <Button size="sm" disabled={busy !== null} onClick={() => void install(t.kind)}>
                    {busy === t.kind && <Spinner />}
                    Install
                  </Button>
                )}
                {a?.installed && a.signedIn !== false && (
                  <span className="inline-flex h-6 items-center gap-1 rounded-full bg-lime-soft px-2.5 text-[13px] font-medium text-leaf-deep">
                    <Check aria-hidden="true" className="size-3.5" />
                    Ready
                  </span>
                )}
              </div>
              {a?.installed && a.signedIn === false && (
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-cream px-3 py-2 text-[14px]">
                  <span className="flex-1">
                    In a terminal, run <code className="font-mono text-[13px]">{t.signIn}</code>, then check again.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(t.signIn);
                      setCopied(t.kind);
                    }}
                  >
                    <Copy aria-hidden="true" className="size-3.5" />
                    {copied === t.kind ? "Copied" : "Copy"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={refreshAgents}>
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    Check
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-[14px] whitespace-pre-wrap text-danger">
          {error}
        </p>
      )}
      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" onClick={onNext}>
          {ready ? "Continue" : "Continue anyway"}
        </Button>
        <span className="text-[14px] text-ink-soft">Other ACP agents can be added in Settings → Agents.</span>
      </div>
    </>
  );
}

function GithubStep({ cloudApi, connected, dashboardUrl, onNext }: SetupWizardProps & { onNext: () => void }) {
  const [list, setList] = useState<{ id: string; accountLogin: string }[] | null | "loading" | "error">("loading");
  const load = () => {
    if (!cloudApi) return setList(null);
    setList("loading");
    cloudApi.githubInstallations().then(setList, () => setList("error"));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [cloudApi]);
  const linked = Array.isArray(list) && list.length > 0;
  return (
    <>
      <Heading
        title="Connect GitHub"
        body="Lets cloud agents clone your private repositories, push their branch and open pull requests. Threads on this computer use your own git sign-in."
      />
      <div className="mt-8 rounded-2xl border border-line bg-paper p-5 shadow-panel">
        {!connected ? (
          <p className="text-[15px] text-ink-soft">Sign in to LemonLime first (step 1) to connect GitHub. You can skip this for now.</p>
        ) : list === "loading" ? (
          <p className="flex items-center gap-2 text-[15px] text-ink-soft">
            <Spinner /> Checking…
          </p>
        ) : list === null ? (
          <p className="text-[15px] text-ink-soft">This server has no GitHub App set up, so cloud agents can only clone public repositories.</p>
        ) : (
          <div className="flex items-center gap-3">
            <GithubMark className={cx("size-5", linked ? "text-leaf" : "text-ink-soft")} />
            <p className="flex-1 text-[15px]">
              {list === "error" ? "Couldn't check." : linked ? `Connected to ${list.map(l => l.accountLogin).join(", ")}.` : "Not connected yet."}
            </p>
            <Button onClick={() => void openExternal(`${dashboardUrl.replace(/\/+$/, "")}/settings#github`)}>{linked ? "Add another" : "Connect"}</Button>
            <Button variant="ghost" onClick={load} aria-label="Check again">
              <RefreshCw aria-hidden="true" className="size-4" />
            </Button>
          </div>
        )}
      </div>
      <div className="mt-6">
        <Button variant="primary" onClick={onNext}>
          {linked ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </>
  );
}
