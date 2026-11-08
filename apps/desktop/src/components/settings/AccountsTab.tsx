import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ACCOUNT_AGENTS, type AccountAgent, type AccountsList, type AgentAccount } from "@lemonlime/protocol";
import { accountLoginInput, addAccount, cancelAccountLogin, listAccounts, removeAccount, setDefaultAccount, signInAccount } from "../../lib/accounts.ts";
import { AGENT_LABELS } from "../../lib/format.ts";
import { confirmAction, inDesktopShell } from "../../lib/native.ts";
import type { LoginUpdate } from "../../lib/useThreadSession.ts";
import { Button, IconButton, Spinner, TextInput, openExternal } from "../ui.tsx";
import { ErrorText, Pill, Row, Section } from "./parts.tsx";

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
export function AccountsTab() {
  const shell = inDesktopShell();
  const [list, setList] = useState<AccountsList | null>(null);
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

  if (!shell) {
    return (
      <Section title="Accounts">
        <p className="text-[14px] text-ink-soft">Accounts work in the desktop app.</p>
      </Section>
    );
  }
  return (
    <>
      {ACCOUNT_AGENTS.map(agent => (
        <Section
          key={agent}
          title={`${AGENT_LABELS[agent]} accounts`}
          description="Each account signs in on its own, with its own plan. New threads use the default one; a thread that hits a usage limit can switch to another."
          aside={
            agent === ACCOUNT_AGENTS[0] ? (
              <IconButton label="Check again" onClick={() => void refresh()} disabled={loading}>
                {loading ? <Spinner /> : <RefreshCw aria-hidden="true" className="size-4" />}
              </IconButton>
            ) : undefined
          }
        >
          {!list && <p className="text-[14px] text-ink-soft">{loading ? "Looking…" : "Couldn't list the accounts."}</p>}
          {list?.agents[agent].map(a => (
            <div key={a.id} className="flex flex-col gap-2">
              <Row
                label={
                  <span className="inline-flex items-center gap-2">
                    {a.label}
                    {a.isDefault && <Pill tone="good">Default</Pill>}
                  </span>
                }
                description={describe(a)}
              >
                {a.signedIn === false && (
                  <Button size="sm" variant="primary" disabled={login !== null || busy !== null} onClick={() => void signIn(agent, a.id, a.label)}>
                    Sign in
                  </Button>
                )}
                {!a.isDefault && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(`default:${agent}:${a.id}`, () => setDefaultAccount(agent, a.id))}
                  >
                    {busy === `default:${agent}:${a.id}` && <Spinner />}
                    Make default
                  </Button>
                )}
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
              </Row>
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
            </div>
          ))}
          {list && (
            <AddAccount
              agent={agent}
              disabled={login !== null || busy !== null}
              onAdd={label =>
                act(`add:${agent}`, async () => {
                  const account = await addAccount(agent, label);
                  void signIn(agent, account.id, account.label);
                })
              }
            />
          )}
        </Section>
      ))}
      <ErrorText>{error}</ErrorText>
    </>
  );
}

function AddAccount({ agent, disabled, onAdd }: { agent: AccountAgent; disabled: boolean; onAdd: (label: string) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    void onAdd(label.trim()).then(() => setLabel(""));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 border-t border-line pt-4" autoComplete="off">
      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] text-ink-soft">
        Name for another {AGENT_LABELS[agent]} account
        <TextInput value={label} onChange={e => setLabel(e.target.value)} placeholder="Personal" maxLength={80} />
      </label>
      <Button type="submit" disabled={disabled || !label.trim()}>
        <Plus aria-hidden="true" className="size-4" />
        Add and sign in
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
