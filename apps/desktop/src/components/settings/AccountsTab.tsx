import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ACCOUNT_AGENTS, hasAccounts, type AccountAgent, type AccountsList, type AgentAccount, type AgentKind } from "@lemonlime/protocol";
import {
  accountLoginInput,
  addAccount,
  cancelAccountLogin,
  lastAccounts,
  listAccounts,
  removeAccount,
  setDefaultAccount,
  signInAccount,
} from "../../lib/accounts.ts";
import { AGENT_LABELS } from "../../lib/format.ts";
import { confirmAction, inDesktopShell } from "../../lib/native.ts";
import type { LoginUpdate } from "../../lib/useThreadSession.ts";
import { AgentIcon } from "../AgentIcon.tsx";
import { Button, IconButton, SegmentedControl, Spinner, TextInput, cx, openExternal } from "../ui.tsx";
import { UsageBar } from "../UsageBar.tsx";
import { ErrorText, Section } from "./parts.tsx";

/** One sign-in under way, for one account. */
interface Login {
  agent: AccountAgent;
  id: string;
  label: string;
  update: LoginUpdate;
}

function describe(a: AgentAccount): string {
  if (a.signedIn === null) return "Couldn't tell whether it's signed in. Is the agent installed?";
  if (!a.signedIn) return a.builtIn ? "Not signed in on this computer." : "Not signed in yet.";
  if (a.email) return `Signed in as ${a.email}${a.plan ? ` (${a.plan})` : ""}.`;
  return a.plan ? `Signed in (${a.plan}).` : "Signed in.";
}

/**
 * Settings → Agents → Accounts: several of the user's own accounts per agent, each kept
 * by the agent in a folder of its own, so a thread that hits one account's usage limit can
 * carry on with another. LemonLime only ever sees names and emails, never a token.
 */
export function AccountsTab({ initialAgent }: { initialAgent?: AgentKind | undefined }) {
  const shell = inDesktopShell();
  const [list, setList] = useState<AccountsList | null>(() => lastAccounts());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const stopListening = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    if (!shell) return;
    setLoading(true);
    try {
      setList(await listAccounts());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [shell]);
  useEffect(() => {
    void refresh();
    return () => {
      stopListening.current?.();
      void cancelAccountLogin();
    };
  }, [refresh]);

  const signIn = async (agent: AccountAgent, id: string, label: string) => {
    stopListening.current?.();
    setLogin({ agent, id, label, update: { state: "starting" } });
    try {
      stopListening.current = await signInAccount(
        agent,
        id,
        update => setLogin(l => (l && l.id === id && l.agent === agent ? { ...l, update } : l)),
        ok => {
          stopListening.current = null;
          if (ok) setLogin(null);
          void refresh();
        },
      );
    } catch (err) {
      setLogin({ agent, id, label, update: { state: "failed", message: err instanceof Error ? err.message : String(err) } });
    }
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const [agent, setAgent] = useState<AccountAgent>(initialAgent && hasAccounts(initialAgent) ? initialAgent : ACCOUNT_AGENTS[0]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (initialAgent && hasAccounts(initialAgent)) setAgent(initialAgent);
  }, [initialAgent]);

  if (!shell) {
    return (
      <Section title="Accounts">
        <p className="text-[14px] text-ink-soft">Accounts work in the desktop app.</p>
      </Section>
    );
  }
  const accounts = list?.agents[agent] ?? [];
  return (
    <section className="mb-8">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-sans text-[15px] font-semibold tracking-normal">Accounts</h3>
          <p className="mt-0.5 text-[13.5px] text-ink-soft">
            Several of your own accounts per agent, each signed in on its own. New threads use the one in use; a thread that hits a usage limit can switch to
            another.
          </p>
        </div>
        <IconButton label="Check again" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-4" />}
        </IconButton>
      </div>
      <div className="mt-4 max-w-[420px]">
        <SegmentedControl
          label="Agent"
          value={agent}
          onChange={a => {
            setAgent(a);
            setAdding(false);
          }}
          options={ACCOUNT_AGENTS.map(a => ({
            value: a,
            label: (
              <span className="inline-flex items-center gap-2">
                <AgentIcon kind={a} color />
                {AGENT_LABELS[a]}
                {list && <span className="font-normal text-ink-faint tabular-nums">{list.agents[a].length}</span>}
              </span>
            ),
          }))}
        />
      </div>
      <div className="mt-6 flex items-center gap-3">
        <h4 className="min-w-0 flex-1 text-[15px] font-semibold">{AGENT_LABELS[agent]} accounts</h4>
        <Button size="sm" variant="ghost" disabled={!list || login !== null || busy !== null} aria-expanded={adding} onClick={() => setAdding(a => !a)}>
          <Plus aria-hidden="true" className="size-4" />
          Add
        </Button>
      </div>
      {adding && (
        <AddAccount
          agent={agent}
          disabled={login !== null || busy !== null}
          onCancel={() => setAdding(false)}
          onAdd={label =>
            act(`add:${agent}`, async () => {
              const account = await addAccount(agent, label);
              setAdding(false);
              void signIn(agent, account.id, account.label);
            })
          }
        />
      )}
      {!list && <p className="mt-3 text-[14px] text-ink-soft">{loading ? "Looking…" : "Couldn't list the accounts."}</p>}
      <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3" aria-label={`${AGENT_LABELS[agent]} accounts`}>
        {accounts.map(a => (
          <li key={a.id} className="flex flex-col gap-3 rounded-2xl border border-line bg-paper p-4">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold text-ink" title={a.email ?? a.label}>
                {a.email ?? a.label}
              </p>
              {a.email && !a.builtIn && a.label !== a.email && <p className="truncate text-[13.5px] text-ink-soft">{a.label}</p>}
              <p className={cx("mt-1 text-[13.5px]", a.isDefault ? "text-leaf" : "text-ink-soft")}>{a.isDefault ? "In use on this computer" : describe(a)}</p>
              {a.isDefault && a.signedIn !== true && <p className="text-[13.5px] text-ink-soft">{describe(a)}</p>}
              {a.plan && a.signedIn && <p className="text-[13.5px] text-ink-soft">{a.plan} plan</p>}
            </div>
            {a.usage && <UsageBars agent={agent} usage={a.usage} />}
            <div className="mt-auto flex flex-wrap items-center gap-2">
              {a.signedIn === false && (
                <Button size="sm" variant="primary" disabled={login !== null || busy !== null} onClick={() => void signIn(agent, a.id, a.label)}>
                  Sign in
                </Button>
              )}
              {!a.isDefault && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void act(`default:${agent}:${a.id}`, () => setDefaultAccount(agent, a.id))}
                >
                  {busy === `default:${agent}:${a.id}` && <Spinner />}
                  Use this one
                </Button>
              )}
              <span className="flex-1" />
              {!a.builtIn && (
                <IconButton
                  label={`Remove ${a.label}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void confirmAction(
                      `Remove the “${a.label}” ${AGENT_LABELS[agent]} account? It's signed out and its folder on this computer is deleted.`,
                    ).then(ok => {
                      if (ok) void act(`remove:${agent}:${a.id}`, () => removeAccount(agent, a.id));
                    })
                  }
                >
                  {busy === `remove:${agent}:${a.id}` ? <Spinner /> : <Trash2 aria-hidden="true" className="size-4" />}
                </IconButton>
              )}
            </div>
            {login?.agent === agent && login.id === a.id && (
              <LoginProgress
                login={login}
                onClose={() => {
                  stopListening.current?.();
                  stopListening.current = null;
                  void cancelAccountLogin();
                  setLogin(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {list && <p className="mt-3 text-[13.5px] text-ink-soft">New threads on this computer use the account in use.</p>}
      <div className="mt-2">
        <ErrorText>{error}</ErrorText>
      </div>
    </section>
  );
}

function AddAccount({
  agent,
  disabled,
  onAdd,
  onCancel,
}: {
  agent: AccountAgent;
  disabled: boolean;
  onAdd: (label: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    void onAdd(label.trim()).then(() => setLabel(""));
  };
  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-paper p-4" autoComplete="off">
      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
        Name for another {AGENT_LABELS[agent]} account
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- it appears because the person just pressed Add */}
        <TextInput value={label} onChange={e => setLabel(e.target.value)} placeholder="Personal" maxLength={80} autoFocus />
      </label>
      <Button type="submit" variant="primary" disabled={disabled || !label.trim()}>
        Add and sign in
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function LoginProgress({ login, onClose }: { login: Login; onClose: () => void }) {
  const [code, setCode] = useState("");
  const u = login.update;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    void accountLoginInput(code.trim());
    setCode("");
  };
  return (
    <div className="ml-1 flex flex-col gap-2.5 rounded-xl border border-line bg-cream px-4 py-3 text-[14px]" role="status">
      {u.state === "starting" && (
        <p className="flex items-center gap-2 text-ink-soft">
          <Spinner /> Starting the sign-in for {login.label}…
        </p>
      )}
      {(u.state === "open_url" || u.state === "needs_input") && (
        <p className="text-ink-soft">Finish signing in to {login.label} in your browser. Use the account you want this one to be.</p>
      )}
      {u.url && u.state !== "failed" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void openExternal(u.url!)}>
            <ExternalLink aria-hidden="true" className="size-3.5" />
            Open the sign-in page
          </Button>
          {u.code && (
            <span className="text-ink-soft">
              and enter <code className="rounded bg-cream-deep px-1.5 py-0.5 font-mono text-ink">{u.code}</code>
            </span>
          )}
        </div>
      )}
      {u.state === "needs_input" && (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2" autoComplete="off">
          <TextInput
            aria-label="Code from the sign-in page"
            placeholder="Paste the code the page shows"
            value={code}
            onChange={e => setCode(e.target.value)}
            className="min-w-56 flex-1 font-mono text-[13px]"
            spellCheck={false}
          />
          <Button type="submit" size="sm" variant="primary" disabled={!code.trim()}>
            Continue
          </Button>
        </form>
      )}
      {u.state === "failed" && <p className="text-danger">{u.message ?? "Sign-in didn't finish."}</p>}
      <div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {u.state === "failed" ? "Close" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Where the plan's limits stand, as the agent itself reported them: one thin bar per
 * window (5h, 7d). Claude Code only reports during a turn, so its bars say when.
 */
function UsageBars({ agent, usage }: { agent: AccountAgent; usage: NonNullable<AgentAccount["usage"]> }) {
  const seen = usageSeen(usage.observedAt);
  return (
    <div className="flex flex-col gap-2" aria-label="Plan usage">
      {usage.windows.map(w => {
        const pct = Math.round(w.usedPercent);
        const resets = w.resetsAt ? resetText(w.resetsAt) : null;
        return (
          <div key={`${w.kind}:${w.label}`} className="grid grid-cols-[28px_1fr_40px] items-center gap-2.5 text-[13px]" title={resets ?? undefined}>
            <span className="text-ink-soft">{w.label}</span>
            <UsageBar percent={pct} label={`${w.label} limit used${resets ? `, ${resets.toLowerCase()}` : ""}`} />
            <span className="text-right text-ink tabular-nums">{pct}%</span>
          </div>
        );
      })}
      {agent === "claude-code" && seen && <p className="text-[12.5px] text-ink-faint">As of the last turn, {seen}</p>}
    </div>
  );
}

/** "3 minutes ago", "yesterday", from when the agent last reported. */
export function usageSeen(iso: string, now = Date.now()): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function resetText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Resets ${sameDay ? "at" : "on"} ${d.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}
