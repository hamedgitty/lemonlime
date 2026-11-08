import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  ACCOUNT_AGENTS,
  AccountId,
  DEFAULT_ACCOUNT_ID,
  hasAccounts,
  OnLimit,
  AccountUsage,
  type AccountAgent,
  type AccountRef,
  type AccountsList,
  type AgentAccount,
  type AgentKind,
  type UsageWindow,
} from "@lemonlime/protocol";
import { findRollout } from "./agents/codex.ts";

/**
 * Several of the user's own accounts per agent, on their own computer. Each extra account
 * is a config folder under `<LemonLime home>/accounts/<agent>/<id>`, which the agent is
 * pointed at (CLAUDE_CONFIG_DIR, CODEX_HOME) and signs in to by itself. LemonLime keeps
 * only names and folders here: it never reads, shows or copies a token, and never copies
 * a credential file from one account to another.
 */

/** The environment variable that points each agent at a config folder. */
export const ACCOUNT_ENV: Record<AccountAgent, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

export interface AccountRecord {
  id: string;
  label: string;
  createdAt: string;
}

export interface AccountsFile {
  onLimit: OnLimit;
  agents: Partial<Record<AccountAgent, { default?: string; accounts: AccountRecord[] }>>;
}

const BUILT_IN_LABEL = "This computer's sign-in";

export function accountsRoot(home: string): string {
  return join(home, "accounts");
}

function accountsFile(home: string): string {
  return join(accountsRoot(home), "accounts.json");
}

/** The saved accounts and setting; an empty list (and "wait") when there are none yet. */
export function loadAccounts(home: string): AccountsFile {
  try {
    const raw = JSON.parse(readFileSync(accountsFile(home), "utf8")) as Partial<AccountsFile>;
    const onLimit = OnLimit.safeParse(raw.onLimit);
    const agents: AccountsFile["agents"] = {};
    for (const kind of ACCOUNT_AGENTS) {
      const a = raw.agents?.[kind];
      if (!a || !Array.isArray(a.accounts)) continue;
      const accounts = a.accounts.filter(r => r && AccountId.safeParse(r.id).success && r.id !== DEFAULT_ACCOUNT_ID && typeof r.label === "string");
      const def = typeof a.default === "string" && (a.default === DEFAULT_ACCOUNT_ID || accounts.some(r => r.id === a.default)) ? a.default : undefined;
      agents[kind] = { accounts, ...(def ? { default: def } : {}) };
    }
    return { onLimit: onLimit.success ? onLimit.data : "wait", agents };
  } catch {
    return { onLimit: "wait", agents: {} };
  }
}

export function saveAccounts(home: string, data: AccountsFile): void {
  const file = accountsFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Every account of an agent, its usual sign-in first. */
export function accountsOf(data: AccountsFile, agent: AccountAgent): (AccountRecord & { builtIn: boolean; isDefault: boolean })[] {
  const a = data.agents[agent];
  const def = a?.default ?? DEFAULT_ACCOUNT_ID;
  return [
    { id: DEFAULT_ACCOUNT_ID, label: BUILT_IN_LABEL, createdAt: "", builtIn: true, isDefault: def === DEFAULT_ACCOUNT_ID },
    ...(a?.accounts ?? []).map(r => ({ ...r, builtIn: false, isDefault: def === r.id })),
  ];
}

export function defaultAccount(data: AccountsFile, agent: AccountAgent): string {
  return data.agents[agent]?.default ?? DEFAULT_ACCOUNT_ID;
}

export function accountRef(data: AccountsFile, agent: AccountAgent, id: string): AccountRef | null {
  const a = accountsOf(data, agent).find(r => r.id === id);
  return a ? { id: a.id, label: a.label } : null;
}

/** The folder an account's agent keeps its sign-in and sessions in; null for the usual one. */
export function accountDir(home: string, agent: AccountAgent, id: string): string | null {
  if (id === DEFAULT_ACCOUNT_ID) return null;
  if (!AccountId.safeParse(id).success) throw new Error(`"${id}" is not an account id`);
  return join(accountsRoot(home), agent, id);
}

/** The agent's usual config folder, as it would pick it with nothing set. */
export function usualAgentDir(agent: AccountAgent, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return agent === "claude-code" ? env.CLAUDE_CONFIG_DIR || join(home, ".claude") : env.CODEX_HOME || join(home, ".codex");
}

/**
 * What to set in the agent's environment for an account. null for the usual account
 * means "leave it as the runner's own environment has it".
 */
export function accountEnv(home: string, agent: AccountAgent, id: string): { name: string; value: string | null } {
  return { name: ACCOUNT_ENV[agent], value: accountDir(home, agent, id) };
}

function newAccountId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "account";
  let id = base === DEFAULT_ACCOUNT_ID ? `${base}-2` : base;
  while (taken.has(id) || !AccountId.safeParse(id).success) id = `${base.slice(0, 30)}-${randomBytes(3).toString("hex")}`;
  return id;
}

/** Add an account: a new, empty config folder the agent then signs in to. */
export function addAccount(home: string, agent: AccountAgent, label: string): AccountRecord {
  const name = label.trim().slice(0, 80);
  if (!name) throw new Error("Give the account a name.");
  const data = loadAccounts(home);
  const list = data.agents[agent]?.accounts ?? [];
  if (list.some(a => a.label.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === BUILT_IN_LABEL.toLowerCase()) {
    throw new Error(`You already have an account called "${name}".`);
  }
  const record: AccountRecord = { id: newAccountId(name, new Set(list.map(a => a.id))), label: name, createdAt: new Date().toISOString() };
  mkdirSync(accountDir(home, agent, record.id)!, { recursive: true, mode: 0o700 });
  data.agents[agent] = { ...data.agents[agent], accounts: [...list, record] };
  saveAccounts(home, data);
  return record;
}

/** Forget an account and delete its folder (its sign-in and its sessions). */
export function removeAccount(home: string, agent: AccountAgent, id: string): void {
  if (id === DEFAULT_ACCOUNT_ID) throw new Error("This computer's own sign-in can't be removed here.");
  const data = loadAccounts(home);
  const a = data.agents[agent];
  if (!a?.accounts.some(r => r.id === id)) throw new Error("There's no such account.");
  const dir = accountDir(home, agent, id)!;
  data.agents[agent] = { accounts: a.accounts.filter(r => r.id !== id), ...(a.default && a.default !== id ? { default: a.default } : {}) };
  saveAccounts(home, data);
  rmSync(dir, { recursive: true, force: true });
}

export function setDefaultAccount(home: string, agent: AccountAgent, id: string): void {
  const data = loadAccounts(home);
  if (!accountsOf(data, agent).some(r => r.id === id)) throw new Error("There's no such account.");
  data.agents[agent] = { accounts: data.agents[agent]?.accounts ?? [], ...(id === DEFAULT_ACCOUNT_ID ? {} : { default: id }) };
  saveAccounts(home, data);
}

export function renameAccount(home: string, agent: AccountAgent, id: string, label: string): void {
  const name = label.trim().slice(0, 80);
  if (!name) throw new Error("Give the account a name.");
  const data = loadAccounts(home);
  const a = data.agents[agent];
  if (!a?.accounts.some(r => r.id === id)) throw new Error("There's no such account.");
  a.accounts = a.accounts.map(r => (r.id === id ? { ...r, label: name } : r));
  saveAccounts(home, data);
}

export function setOnLimit(home: string, onLimit: OnLimit): void {
  const data = loadAccounts(home);
  data.onLimit = onLimit;
  saveAccounts(home, data);
}

/**
 * The account to carry on with after `current` hit its limit: the next one in the list
 * (wrapping round) that is signed in and hasn't hit a limit in this go. null if none.
 */
export function nextAccount(
  ids: readonly string[],
  current: string,
  tried: ReadonlySet<string>,
  signedIn: (id: string) => boolean = () => true,
): string | null {
  const start = ids.indexOf(current);
  for (let i = 1; i <= ids.length; i++) {
    const id = ids[(Math.max(start, 0) + i) % ids.length]!;
    if (id !== current && !tried.has(id) && signedIn(id)) return id;
  }
  return null;
}

/**
 * Whether an account looks signed in, from what the agent left in its folder, without
 * reading any token: Claude Code notes the account in `.claude.json` (or keeps a
 * credentials file on Linux); Codex keeps `auth.json`. Quick enough to ask at a limit.
 */
export function looksSignedIn(agent: AccountAgent, dir: string | null, env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (agent === "claude-code") {
    if (!dir && (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY)) return true;
    const root = dir ?? usualAgentDir(agent, env, home);
    const config = dir ? join(dir, ".claude.json") : env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
    if (existsSync(join(root, ".credentials.json"))) return true;
    try {
      return Boolean((JSON.parse(readFileSync(config, "utf8")) as { oauthAccount?: unknown }).oauthAccount);
    } catch {
      return false;
    }
  }
  if (!dir && (env.OPENAI_API_KEY || env.CODEX_API_KEY)) return true;
  return existsSync(join(dir ?? usualAgentDir(agent, env, home), "auth.json"));
}

/** The other agents signed in where this runner is, best guess, for a limit row's choices. */
export function signedInAgents(env: NodeJS.ProcessEnv = process.env, home = homedir()): AgentKind[] {
  const out: AgentKind[] = [];
  for (const kind of ACCOUNT_AGENTS) if (looksSignedIn(kind, null, env, home)) out.push(kind);
  const xdg = env.XDG_DATA_HOME || join(home, ".local", "share");
  if (existsSync(join(xdg, "opencode", "auth.json"))) out.push("opencode");
  return out;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : null) : 0;
      // Some CLIs say how they're signed in on stderr.
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

// ── Plan usage, as the agents report it ─────────────────────────────

function usageFile(home: string, agent: AccountAgent, id: string): string {
  if (!AccountId.safeParse(id).success) throw new Error(`"${id}" is not an account id`);
  return join(accountsRoot(home), "usage", `${agent}-${id}.json`);
}

/** Keep the latest usage an agent reported for an account (Claude Code reports it each turn). */
export function saveAccountUsage(home: string, agent: AccountAgent, id: string, windows: UsageWindow[], now = new Date()): void {
  if (!windows.length) return;
  const file = usageFile(home, agent, id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ windows, observedAt: now.toISOString() } satisfies AccountUsage));
  renameSync(tmp, file);
}

export function readAccountUsage(home: string, agent: AccountAgent, id: string): AccountUsage | null {
  try {
    const r = AccountUsage.safeParse(JSON.parse(readFileSync(usageFile(home, agent, id), "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Codex's `account/rateLimits/read` answer as bars (primary: the 5-hour window, secondary: the week). */
export function codexUsageWindows(result: unknown): UsageWindow[] {
  const limits = (result as { rateLimits?: { primary?: unknown; secondary?: unknown } } | null)?.rateLimits;
  if (!limits) return [];
  const out: UsageWindow[] = [];
  for (const w of [limits.primary, limits.secondary]) {
    const v = w as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null;
    if (!v || typeof v.usedPercent !== "number" || !Number.isFinite(v.usedPercent)) continue;
    const mins = typeof v.windowDurationMins === "number" ? v.windowDurationMins : null;
    const kind: UsageWindow["kind"] = mins === 300 ? "five_hour" : mins === 10_080 ? "seven_day" : "other";
    const label =
      kind === "five_hour" ? "5h" : kind === "seven_day" ? "7d" : mins ? (mins % 1440 === 0 ? `${mins / 1440}d` : `${Math.round(mins / 60)}h`) : "Limit";
    const at = typeof v.resetsAt === "number" && Number.isFinite(v.resetsAt) ? new Date(v.resetsAt * 1000) : null;
    out.push({
      kind,
      label,
      usedPercent: Math.min(100, Math.max(0, v.usedPercent)),
      ...(at && !Number.isNaN(at.getTime()) ? { resetsAt: at.toISOString() } : {}),
    });
  }
  return out;
}

/**
 * Ask Codex itself where an account's plan limits stand: its app-server answers
 * `account/rateLimits/read` from the account's own sign-in, without running a model.
 * Null when Codex isn't there, isn't signed in, or doesn't answer in time.
 */
export function codexUsage(dir: string | null, timeoutMs = 12_000): Promise<UsageWindow[] | null> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    if (dir) env.CODEX_HOME = dir;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    let done = false;
    const finish = (v: UsageWindow[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (m: object) => child.stdin?.write(`${JSON.stringify(m)}\n`);
    let buf = "";
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.length > 1024 * 1024) return finish(null);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { id?: unknown; result?: unknown; error?: unknown };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          continue;
        }
        if (m.id === 0) {
          send({ method: "initialized" });
          send({ method: "account/rateLimits/read", id: 1 });
        } else if (m.id === 1) {
          const windows = m.error ? [] : codexUsageWindows(m.result);
          finish(windows.length ? windows : null);
        }
      }
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "lemonlime", version: "1" } } });
  });
}

/** What the agent itself says about an account: signed in, and as whom where it says. */
export async function accountStatus(agent: AccountAgent, dir: string | null): Promise<Pick<AgentAccount, "signedIn" | "email" | "plan">> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (dir) env[ACCOUNT_ENV[agent]] = dir;
  if (agent === "claude-code") {
    const r = await run("claude", ["auth", "status", "--json"], env);
    return parseClaudeStatus(r.stdout) ?? { signedIn: r.code === null ? null : looksSignedIn(agent, dir) };
  }
  const r = await run("codex", ["login", "status"], env);
  if (r.code === null) return { signedIn: null };
  return parseCodexStatus(`${r.stdout}\n${r.stderr}`, r.code);
}

/** `claude auth status --json`: whether it's signed in, the email and the plan. Null if unreadable. */
export function parseClaudeStatus(stdout: string): Pick<AgentAccount, "signedIn" | "email" | "plan"> | null {
  try {
    const o = JSON.parse(stdout.trim()) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
    if (typeof o.loggedIn !== "boolean") return null;
    return {
      signedIn: o.loggedIn,
      ...(o.loggedIn && typeof o.email === "string" && o.email ? { email: o.email.slice(0, 200) } : {}),
      ...(o.loggedIn && typeof o.subscriptionType === "string" && o.subscriptionType ? { plan: o.subscriptionType.slice(0, 80) } : {}),
    };
  } catch {
    return null;
  }
}

/** `codex login status`: "Logged in using ChatGPT" (exit 0) or "Not logged in" (non-zero). */
export function parseCodexStatus(stdout: string, code: number): Pick<AgentAccount, "signedIn" | "plan"> {
  const text = stdout.trim();
  if (/not logged in/i.test(text) || code !== 0) return { signedIn: false };
  const how = /logged in using (?:an? )?(.+)$/im.exec(text)?.[1]?.trim();
  return { signedIn: true, ...(how ? { plan: how.slice(0, 80) } : {}) };
}

/** Every account with what its agent says about it (for Settings). */
export async function listAccounts(home: string): Promise<AccountsList> {
  const data = loadAccounts(home);
  const agents = {} as AccountsList["agents"];
  await Promise.all(
    ACCOUNT_AGENTS.map(async kind => {
      agents[kind] = await Promise.all(
        accountsOf(data, kind).map(async a => {
          const dir = accountDir(home, kind, a.id);
          const status = await accountStatus(kind, dir);
          // Codex says where the limits stand whenever asked; Claude Code only during a turn,
          // so its bars show what it last reported on this account.
          if (kind === "codex" && status.signedIn !== false) {
            const live = await codexUsage(dir);
            if (live) saveAccountUsage(home, kind, a.id, live);
          }
          const usage = status.signedIn === false ? null : readAccountUsage(home, kind, a.id);
          return { id: a.id, label: a.label, builtIn: a.builtIn, isDefault: a.isDefault, ...status, ...(usage ? { usage } : {}) };
        }),
      );
    }),
  );
  return { onLimit: data.onLimit, agents };
}

/**
 * Bring the agent's own record of a conversation over to another account's folder, so the
 * same conversation carries on there: Claude Code's `projects/<folder>/<session>.jsonl`
 * (and its folder of tool output), Codex's `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.
 * Only the conversation is copied, never a sign-in. Returns false when it isn't there.
 */
export function carrySession(agent: AgentKind, saved: Record<string, string>, fromDir: string, toDir: string): boolean {
  if (!hasAccounts(agent)) return false;
  if (fromDir === toDir) return true;
  if (agent === "claude-code") {
    const id = saved.sessionId;
    if (!id || !/^[A-Za-z0-9-]{1,100}$/.test(id)) return false;
    const projects = join(fromDir, "projects");
    let folders: string[] = [];
    try {
      folders = readdirSync(projects);
    } catch {
      return false;
    }
    for (const folder of folders) {
      const file = join(projects, folder, `${id}.jsonl`);
      if (!existsSync(file)) continue;
      const target = join(toDir, "projects", folder);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      copyFileSync(file, join(target, `${id}.jsonl`));
      const extra = join(projects, folder, id);
      if (existsSync(extra)) cpSync(extra, join(target, id), { recursive: true });
      return true;
    }
    return false;
  }
  const id = saved.threadId;
  if (!id || !/^[A-Za-z0-9-]{1,100}$/.test(id)) return false;
  const rollout = findRollout(fromDir, id);
  if (!rollout) return false;
  const target = join(toDir, relative(fromDir, rollout));
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(rollout, target);
  return true;
}
