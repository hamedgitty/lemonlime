import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ThreadId } from "@lemonlime/protocol";
import { keysFromSecret, MAX_RUNNER_TOKEN_SECONDS, type ThreadKeys } from "./keys.ts";

/**
 * `lemonlime-runner keeper --thread <id> [--agent-user <name>] -- <command…>`
 *
 * Holds the thread secret so nothing the agent can reach does. Started as root in a
 * sandbox, it takes the secret from its environment, then starts `<command>` (the setup
 * script and the runner) as the agent's user without it. The runner asks the keeper over a
 * local socket to check tokens and to sign its own short-lived runner tokens. The keeper
 * never signs a token for the user's apps, so even an agent that talks to it can't act as
 * the user, and as root its memory and starting environment are out of the agent's reach.
 */
export async function keeper(argv: string[]): Promise<void> {
  const split = argv.indexOf("--");
  const { values } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    options: { thread: { type: "string" }, "agent-user": { type: "string" } },
    strict: true,
  });
  const command = split === -1 ? [] : argv.slice(split + 1);
  const threadId = ThreadId.safeParse(values.thread);
  if (!threadId.success) throw new Error("--thread is required and must be a valid thread id");
  if (command.length === 0) throw new Error("usage: lemonlime-runner keeper --thread <id> [--agent-user <name>] -- <command…>");
  const secret = process.env.LEMONLIME_THREAD_SECRET ?? "";
  if (secret.length < 16) throw new Error("LEMONLIME_THREAD_SECRET must be set (at least 16 characters)");
  delete process.env.LEMONLIME_THREAD_SECRET;

  const user = values["agent-user"] ? lookUpUser(values["agent-user"]) : null;
  if (user && process.getuid?.() !== 0) throw new Error("--agent-user needs the keeper to start as root");

  const keys = await keysFromSecret(threadId.data, secret);
  const dir = mkdtempSync(join(tmpdir(), "lemonlime-keeper-"));
  const socket = join(dir, "keeper.sock");
  const server = await serveKeys(socket, keys);
  // The agent's user can reach the socket (the runner runs as it) but list nothing else here.
  chmodSync(dir, 0o711);
  chmodSync(socket, 0o666);

  const env: NodeJS.ProcessEnv = { ...process.env, LEMONLIME_KEEPER: socket };
  if (user) Object.assign(env, { HOME: user.home, USER: user.name, LOGNAME: user.name });
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    env,
    ...(user ? { uid: user.uid, gid: user.gid, cwd: user.home } : {}),
  });
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(code ?? (signal ? 1 : 0));
  });
}

/** Answer the runner's requests on a local socket: one line of JSON each way. */
export function serveKeys(socket: string, keys: ThreadKeys): Promise<Server> {
  const server = createServer(conn => {
    let buf = "";
    conn.on("data", d => {
      buf += d.toString();
      if (buf.length > 64 * 1024) return conn.destroy();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        void answer(line, keys).then(a => conn.write(JSON.stringify(a) + "\n"));
      }
    });
    conn.on("error", () => conn.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve(server));
  });
}

async function answer(line: string, keys: ThreadKeys): Promise<Record<string, unknown>> {
  let req: { op?: unknown; token?: unknown; seconds?: unknown };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    return { error: "bad request" };
  }
  switch (req.op) {
    case "agentKey":
      return { agentKey: keys.agentKey };
    case "verify":
      if (typeof req.token !== "string" || req.token.length > 4096) return { error: "bad token" };
      return { result: await keys.verify(req.token) };
    case "sign": {
      // Runner tokens only, short-lived: never a token that opens the thread as the user.
      const seconds = typeof req.seconds === "number" ? Math.min(Math.max(1, Math.floor(req.seconds)), MAX_RUNNER_TOKEN_SECONDS) : 120;
      return { token: await keys.signRunner(seconds) };
    }
    default:
      return { error: "unknown request" };
  }
}

function lookUpUser(name: string): { name: string; uid: number; gid: number; home: string } {
  const line = readFileSync("/etc/passwd", "utf8")
    .split("\n")
    .find(l => l.split(":")[0] === name);
  if (!line) throw new Error(`There's no user called ${name}`);
  const [, , uid, gid, , home] = line.split(":");
  const user = { name, uid: Number(uid), gid: Number(gid), home: home || `/home/${name}` };
  if (!Number.isInteger(user.uid) || user.uid === 0) throw new Error(`${name} can't be the agent's user`);
  return user;
}
