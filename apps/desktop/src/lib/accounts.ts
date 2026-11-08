import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AccountsList, hasAccounts, matchingModel, type AccountAgent, type AgentKind, type OnLimit, type ThreadEvent } from "@lemonlime/protocol";
import { RunnerClient } from "@lemonlime/client";
import { resolveConnection, type LoginUpdate } from "./useThreadSession.ts";
import type { LocalThreadMeta } from "./storage.ts";
import type { AgentInstall, LocalRunnerStatus } from "./system.ts";

/** Wrappers around src-tauri/src/accounts.rs: the user's agent accounts on this computer. */

let runnerPath = "";
/** The runner the account commands use (Settings → Advanced keeps it current). */
export function setAccountsRunnerPath(path: string): void {
  runnerPath = path;
}

async function accounts(command: string, args: { agent?: string; id?: string; label?: string; onLimit?: OnLimit } = {}): Promise<unknown> {
  return invoke("agent_accounts", { command, agent: null, id: null, label: null, onLimit: null, ...args, runnerPath: runnerPath || null });
}

/** Every account per agent, and the limit setting. Null outside the desktop app. */
const LAST_LIST_KEY = "lemonlime:accounts-last";

export async function listAccounts(): Promise<AccountsList | null> {
  if (!isTauri()) return null;
  const parsed = AccountsList.safeParse(await accounts("list"));
  if (!parsed.success) throw new Error("The runner's list of accounts couldn't be read. Is it up to date?");
  try {
    localStorage.setItem(LAST_LIST_KEY, JSON.stringify(parsed.data));
  } catch {
    /* only a convenience */
  }
  return parsed.data;
}

/**
 * The list as it was last seen, so the Accounts tab shows at once while the agents are
 * asked again (names, emails and usage only: the list never holds a token).
 */
export function lastAccounts(): AccountsList | null {
  try {
    const raw = localStorage.getItem(LAST_LIST_KEY);
    const r = raw ? AccountsList.safeParse(JSON.parse(raw)) : null;
    return r?.success ? r.data : null;
  } catch {
    return null;
  }
}

export async function addAccount(agent: AccountAgent, label: string): Promise<{ id: string; label: string }> {
  const r = (await accounts("add", { agent, label })) as { account?: { id: string; label: string } };
  if (!r.account) throw new Error("The account couldn't be added.");
  return r.account;
}

export async function removeAccount(agent: AccountAgent, id: string): Promise<void> {
  await accounts("remove", { agent, id });
}

export async function setDefaultAccount(agent: AccountAgent, id: string): Promise<void> {
  await accounts("default", { agent, id });
}

export async function renameAccount(agent: AccountAgent, id: string, label: string): Promise<void> {
  await accounts("rename", { agent, id, label });
}

export async function setOnLimit(onLimit: OnLimit): Promise<void> {
  await accounts("on-limit", { onLimit });
}

/** Sign an account in. Progress arrives through `onUpdate`; `onDone` once it's over. Returns a stop function for the listener. */
export async function signInAccount(agent: AccountAgent, id: string, onUpdate: (u: LoginUpdate) => void, onDone: (ok: boolean) => void): Promise<() => void> {
  const stop = await listen<{ line: { login?: LoginUpdate; done?: boolean; ok?: boolean } }>("account-login", e => {
    const line = e.payload.line;
    if (line.login) onUpdate(line.login);
    if (line.done) {
      stop();
      onDone(Boolean(line.ok));
    }
  });
  try {
    await invoke("account_login_start", { agent, id, runnerPath: runnerPath || null });
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}

export async function accountLoginInput(text: string): Promise<void> {
  await invoke("account_login_input", { text });
}

export async function cancelAccountLogin(): Promise<void> {
  if (isTauri()) await invoke("account_login_cancel");
}

/** The usage limit a thread is stopped on, as its runner's /healthz says. */
export interface LimitedThread {
  threadId: string;
  agent: AgentKind;
  account: string | null;
}

/** Other threads on this computer stopped on the same agent's limit, with the same account. */
export function threadsOnSameLimit(statuses: readonly LocalRunnerStatus[], except: string, agent: AgentKind, account: string | null): string[] {
  return statuses
    .filter(s => s.threadId !== except)
    .filter(s => {
      const limit = s.health.limit;
      return limit && limit.agent === agent && (limit.account ?? null) === account;
    })
    .map(s => s.threadId);
}

/** What a limit row can offer to carry the thread on with. */
export interface LimitChoices {
  /** Other signed-in accounts of the same agent. */
  accounts: { id: string; label: string; email?: string | undefined }[];
  /** Other agents signed in, each with a model of the same tier where it lists models. */
  agents: { kind: AgentKind; model: string | null }[];
}

/**
 * The choices for a limit row. Local threads go by what this computer has now (accounts
 * and agents signed in); cloud threads by what the sandbox's runner said when the limit
 * was hit. Accounts only where the thread can switch them.
 */
export function limitChoices(o: {
  hit: Extract<ThreadEvent, { type: "limit_hit" }>;
  mode: "local" | "cloud";
  model: string | null;
  accounts: AccountsList | null;
  agents: readonly AgentInstall[] | null;
}): LimitChoices {
  const { hit } = o;
  let accounts: LimitChoices["accounts"] = [];
  if (o.mode === "local" && hasAccounts(hit.agent)) {
    const list = o.accounts?.agents[hit.agent];
    accounts = list
      ? list.filter(a => a.id !== (hit.account?.id ?? "default") && a.signedIn === true).map(a => ({ id: a.id, label: a.label, email: a.email }))
      : hit.accounts.map(a => ({ id: a.id, label: a.label }));
  }
  const signedIn: AgentKind[] = o.mode === "local" && o.agents ? o.agents.filter(a => a.installed && a.signedIn !== false).map(a => a.kind) : [...hit.agents];
  const agents = [...new Set(signedIn)].filter(k => k !== hit.agent && k !== "acp").map(kind => ({ kind, model: matchingModel(hit.agent, o.model, kind) }));
  return { accounts, agents };
}

/**
 * Switch other local threads stopped on the same limit to `accountId` too: connect to each
 * one's runner, ask, and wait (briefly) for it to say it switched. Resolves with how many did.
 */
export async function switchThreadsAccount(
  threads: readonly { meta: LocalThreadMeta; latestSeq: number }[],
  runnerPath: string,
  accountId: string,
): Promise<number> {
  const results = await Promise.all(
    threads.map(async ({ meta, latestSeq }) => {
      const conn = await resolveConnection({ mode: "local", meta, runnerPath }).catch(() => null);
      if (!conn) return false;
      return new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.close();
          resolve(ok);
        };
        const client = new RunnerClient({
          url: conn.url,
          token: conn.token,
          resumeFrom: latestSeq,
          onEvent: e => e.type === "agent_switch" && finish(true),
          onError: () => finish(false),
        });
        const timer = setTimeout(() => finish(false), 15_000);
        client.connect();
        client.limitAction({ action: "switch_account", accountId });
      });
    }),
  );
  return results.filter(Boolean).length;
}
