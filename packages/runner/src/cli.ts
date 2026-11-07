import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentKind, branchForThread, ThreadId, type Thread } from "@lemonlime/protocol";
import { adapterFor, type Autonomy } from "./agents/index.ts";
import { GitWorkspace } from "./git.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { startServer } from "./server.ts";
import { ThreadRunner } from "./thread-runner.ts";
import { RUNNER_VERSION } from "./version.ts";

const HELP = `lemonlime-runner — run one coding agent and stream its work

Usage: lemonlime-runner --thread <id> --agent <kind> [options]
       lemonlime-runner cleanup --thread <id> --source-repo <path>
                        Remove a local thread's worktree (its branch and commits stay)
                        and its local history

  --thread <id>            Thread id (required)
  --agent <kind>           claude-code | codex | opencode | acp (required)
  --agent-command <cmd>    Command for ACP agents, e.g. "gemini --experimental-acp"
  --model <name>           Model to ask the agent for
  --workdir <path>         Repository working directory (default: ./workspace)
  --repo <url>             Clone this repository into --workdir if it is empty
  --source-repo <path>     Work in a separate git worktree of this local repository, so
                           its checked-out branch and uncommitted work are never touched
                           (worktree default: ~/.lemonlime/worktrees/<repo>/<thread>)
  --base <branch>          Branch the agent branch starts from (default: main)
  --port <n>               Port to listen on (default: 7420)
  --host <addr>            Interface to bind (default: 127.0.0.1)
  --data-dir <path>        Where history is stored (default: <workdir>/.lemonlime, or
                           ~/.lemonlime/threads/<thread> with --source-repo)
  --control-plane <url>    Send heartbeats to this control plane
  --autonomy <level>       full | edits (default: full inside a sandbox, otherwise edits)
  --no-git                 Don't manage a branch or commit changes
  -h, --help               Show this help

Environment:
  LEMONLIME_THREAD_SECRET  The thread's secret (required)
  LEMONLIME_HOME           Where worktrees and local history live (default: ~/.lemonlime)
`;

/** Split a command string into args, honouring simple quotes. */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Root for worktrees and local history: $LEMONLIME_HOME or ~/.lemonlime. */
export function lemonlimeHome(): string {
  return resolve(process.env.LEMONLIME_HOME || join(homedir(), ".lemonlime"));
}

/** A stable, readable folder per repository, so two repos with the same name never collide. */
export function worktreePathFor(home: string, sourceRepo: string, threadId: string): string {
  const name = basename(sourceRepo).replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
  const hash = createHash("sha256").update(resolve(sourceRepo)).digest("hex").slice(0, 8);
  return join(home, "worktrees", `${name}-${hash}`, threadId);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "cleanup") return cleanup(argv.slice(1));
  const { values } = parseArgs({
    args: argv,
    options: {
      thread: { type: "string" },
      agent: { type: "string" },
      "agent-command": { type: "string" },
      model: { type: "string" },
      workdir: { type: "string" },
      "source-repo": { type: "string" },
      repo: { type: "string" },
      base: { type: "string", default: "main" },
      port: { type: "string", default: process.env.LEMONLIME_RUNNER_PORT ?? "7420" },
      host: { type: "string", default: "127.0.0.1" },
      "data-dir": { type: "string" },
      "control-plane": { type: "string" },
      autonomy: { type: "string" },
      "no-git": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const fail = (msg: string): never => {
    process.stderr.write(`lemonlime-runner: ${msg}\n\n${HELP}`);
    process.exit(2);
  };

  const threadId = ThreadId.safeParse(values.thread);
  if (!threadId.success) fail("--thread is required and must be a valid thread id");
  const agent = AgentKind.safeParse(values.agent);
  if (!agent.success) fail("--agent must be one of claude-code, codex, opencode, acp");
  const secret = process.env.LEMONLIME_THREAD_SECRET ?? "";
  if (secret.length < 16) fail("LEMONLIME_THREAD_SECRET must be set (at least 16 characters)");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be a valid port number");

  const inSandbox = process.env.LEMONLIME_SANDBOX === "1";
  const autonomy = (values.autonomy ?? (inSandbox ? "full" : "edits")) as Autonomy;
  if (autonomy !== "full" && autonomy !== "edits") fail("--autonomy must be full or edits");

  const sourceRepo = values["source-repo"] ? resolve(values["source-repo"]) : undefined;
  if (sourceRepo && values.repo) fail("use either --repo or --source-repo, not both");
  if (sourceRepo && values["no-git"]) fail("--source-repo needs git; drop --no-git");
  const home = lemonlimeHome();
  const workdir = resolve(values.workdir ?? (sourceRepo ? worktreePathFor(home, sourceRepo, threadId.data!) : "./workspace"));
  const dataDir = resolve(values["data-dir"] ?? (sourceRepo ? join(home, "threads", threadId.data!) : `${workdir}/.lemonlime`));
  const command = values["agent-command"] ? splitCommand(values["agent-command"]) : undefined;
  const now = new Date().toISOString();
  const id = threadId.data!;

  const thread: Thread = {
    id,
    title: "",
    agent: { kind: agent.data!, ...(command ? { command } : {}), ...(values.model ? { model: values.model } : {}) },
    repo: { url: values.repo ?? sourceRepo ?? workdir, baseBranch: values.base! },
    branch: branchForThread(id),
    mode: inSandbox ? "cloud" : "local",
    status: "provisioning",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };

  const runner = new ThreadRunner({
    thread,
    workdir,
    dataDir,
    adapter: adapterFor(agent.data!),
    session: { autonomy, ...(values.model ? { model: values.model } : {}), ...(command ? { command } : {}) },
    git: !values["no-git"],
    ...(values.repo ? { repoUrl: values.repo } : {}),
    ...(sourceRepo ? { sourceRepo } : {}),
  });

  const log = (m: string) => process.stderr.write(`[runner ${id}] ${m}\n`);
  await runner.init();
  const server = await startServer(runner, { host: values.host!, port, threadSecret: secret, version: RUNNER_VERSION });
  log(`listening on ${values.host}:${server.port} (agent: ${agent.data}, autonomy: ${autonomy})`);
  // Machine-readable line for parent processes (e.g. the desktop app) that asked for port 0.
  process.stdout.write(JSON.stringify({ event: "ready", port: server.port }) + "\n");

  const shutdown = async (code = 0) => {
    stopHeartbeat?.();
    await runner.close();
    await server.close();
    process.exit(code);
  };
  const stopHeartbeat = values["control-plane"]
    ? startHeartbeat(runner, { controlPlaneUrl: values["control-plane"], threadSecret: secret, version: RUNNER_VERSION, onShutdown: () => void shutdown(0), log })
    : null;

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

/** `lemonlime-runner cleanup`: forget a local thread's worktree and history. */
export async function cleanup(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { thread: { type: "string" }, "source-repo": { type: "string" }, workdir: { type: "string" }, "data-dir": { type: "string" } },
    strict: true,
  });
  const id = ThreadId.safeParse(values.thread);
  if (!id.success || !values["source-repo"]) {
    process.stderr.write("lemonlime-runner cleanup: --thread and --source-repo are required\n");
    process.exit(2);
  }
  const sourceRepo = resolve(values["source-repo"]!);
  const home = lemonlimeHome();
  const workdir = resolve(values.workdir ?? worktreePathFor(home, sourceRepo, id.data!));
  const dataDir = resolve(values["data-dir"] ?? join(home, "threads", id.data!));
  if (existsSync(sourceRepo)) await new GitWorkspace(workdir).removeWorktree(sourceRepo);
  // If the repository itself is gone, the worktree folder is just files now.
  rmSync(workdir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ event: "cleaned", workdir, dataDir }) + "\n");
}

const isEntry = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts");
if (isEntry) {
  main().catch(err => {
    process.stderr.write(`lemonlime-runner: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
