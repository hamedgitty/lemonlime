import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { hasAccounts, OnLimit, type AccountAgent } from "@lemonlime/protocol";
import {
  ACCOUNT_ENV,
  accountDir,
  addAccount,
  listAccounts,
  loadAccounts,
  looksSignedIn,
  removeAccount,
  renameAccount,
  setDefaultAccount,
  setOnLimit,
  accountsOf,
} from "./accounts.ts";
import { LoginSession, type LoginPlan } from "./login.ts";

const USAGE = `usage: lemonlime-runner accounts <command>

  list                                   Every account per agent, as JSON
  add --agent <kind> --label <name>      Add an account (an empty folder to sign in to)
  remove --agent <kind> --id <id>        Sign it out and delete its folder
  default --agent <kind> --id <id>       New threads use this account
  rename --agent <kind> --id <id> --label <name>
  on-limit wait|switch|ask               What to do when an agent hits its usage limit
  login --agent <kind> --id <id>         Sign the account in; prints {"login":…} lines and
                                         reads anything the sign-in asks for on stdin
                                         (closing stdin cancels it)

<kind> is claude-code or codex. Accounts live in $LEMONLIME_HOME/accounts.`;

/** How each agent signs in to an account on the user's own computer (its browser opens). */
const LOCAL_LOGIN: Record<AccountAgent, string[]> = {
  "claude-code": ["claude", "auth", "login", "--claudeai"],
  codex: ["codex", "login"],
};
const LOGOUT: Record<AccountAgent, string[]> = {
  "claude-code": ["claude", "auth", "logout"],
  codex: ["codex", "logout"],
};

function agentArg(value: string | undefined): AccountAgent {
  if (!value || !hasAccounts(value)) throw new Error("--agent must be claude-code or codex");
  return value;
}

function need(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

/** `lemonlime-runner accounts …` (see USAGE). Prints one JSON object as its last line. */
export async function accountsCommand(argv: string[], home: string): Promise<void> {
  const [command, ...rest] = argv;
  const write = (o: unknown): void => void process.stdout.write(`${JSON.stringify(o)}\n`);
  try {
    if (!command || command === "--help" || command === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (command === "on-limit") {
      const parsed = OnLimit.safeParse(rest[0]);
      if (!parsed.success) throw new Error("on-limit takes wait, switch or ask");
      setOnLimit(home, parsed.data);
      return write({ ok: true, onLimit: parsed.data });
    }
    const { values } = parseArgs({
      args: rest,
      options: { agent: { type: "string" }, id: { type: "string" }, label: { type: "string" } },
      strict: true,
    });
    switch (command) {
      case "list":
        return write(await listAccounts(home));
      case "add": {
        const record = addAccount(home, agentArg(values.agent), need(values.label, "--label"));
        return write({ ok: true, account: { id: record.id, label: record.label } });
      }
      case "remove": {
        const agent = agentArg(values.agent);
        const id = need(values.id, "--id");
        if (!accountsOf(loadAccounts(home), agent).some(a => a.id === id && !a.builtIn)) throw new Error("There's no such account.");
        // Sign it out first so nothing of it is left with the agent (on macOS, its keychain item).
        await signOut(agent, accountDir(home, agent, id)!);
        removeAccount(home, agent, id);
        return write({ ok: true });
      }
      case "default":
        setDefaultAccount(home, agentArg(values.agent), need(values.id, "--id"));
        return write({ ok: true });
      case "rename":
        renameAccount(home, agentArg(values.agent), need(values.id, "--id"), need(values.label, "--label"));
        return write({ ok: true });
      case "login":
        return await login(home, agentArg(values.agent), need(values.id, "--id"), write);
      default:
        throw new Error(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    process.stderr.write(`lemonlime-runner: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

function signOut(agent: AccountAgent, dir: string): Promise<void> {
  const [cmd, ...args] = LOGOUT[agent];
  return new Promise(resolve => {
    execFile(cmd!, args, { env: { ...process.env, [ACCOUNT_ENV[agent]]: dir }, timeout: 15_000, windowsHide: true }, () => resolve());
  });
}

async function login(home: string, agent: AccountAgent, id: string, write: (o: unknown) => void): Promise<void> {
  if (!accountsOf(loadAccounts(home), agent).some(a => a.id === id)) throw new Error("There's no such account.");
  const dir = accountDir(home, agent, id);
  const plan: LoginPlan = {
    command: LOCAL_LOGIN[agent],
    // Signed in when the agent says so in its folder; the token itself is never read.
    credential: () => (looksSignedIn(agent, dir) ? { kind: "file", name: "", value: "" } : null),
  };
  const session = new LoginSession(agent, u => write({ login: u }), {
    cwd: homedir(),
    plan,
    openBrowser: true,
    ...(dir ? { env: { [ACCOUNT_ENV[agent]]: dir } } : {}),
  });
  let finished = false;
  const input = createInterface({ input: process.stdin });
  input.on("line", line => line.trim() && session.input(line));
  // The app closes our input to cancel.
  input.on("close", () => !finished && session.cancel());
  const result = await session.run();
  finished = true;
  input.close();
  write({ done: true, ok: result !== null });
}
