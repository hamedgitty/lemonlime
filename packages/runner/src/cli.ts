import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentKind, branchForThread, signToken, ThreadId, type Thread } from "@lemonlime/protocol";
import { adapterFor, type Autonomy } from "./agents/index.ts";
import { runApprovalMcp } from "./approval-mcp.ts";
import { GitWorkspace } from "./git.ts";
import { secretsFromEnv } from "./redact.ts";
import { credentialHelperCommand, gitCredential } from "./git-credential.ts";
import type { AgentCredential } from "./login.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { formatGb, MemoryGuard } from "./memory-guard.ts";
import { loadPty } from "./terminal.ts";
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
  --skills <dir>           Also copy the skill folders in <dir> into the thread (repeatable).
                           Skills in ~/.lemonlime/skills are always copied too.
  --no-bundled-skills      Don't copy LemonLime's own skills into the thread
  --memory-limit-mb <n>    Local threads: stop the agent when what it started uses more
                           than this much memory (default: half the computer's)
  --no-git                 Don't manage a branch or commit changes
  -h, --help               Show this help

Environment:
  LEMONLIME_THREAD_SECRET  The thread's secret (required)
  LEMONLIME_HOME           Where worktrees and local history live (default: ~/.lemonlime)
  LEMONLIME_REDACT_ENV     Comma-separated names of variables holding secrets; their
                           values are removed from every event
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  // `pnpm runner -- --help` passes the `--` along; it isn't an argument.
  const argv = args[0] === "--" ? args.slice(1) : args;
  if (argv[0] === "cleanup") return cleanup(argv.slice(1));
  if (argv[0] === "approval-mcp") return runApprovalMcp();
  if (argv[0] === "git-credential") {
    const input = await new Promise<string>(resolve => {
      let data = "";
      process.stdin.on("data", d => (data += d));
      process.stdin.on("end", () => resolve(data));
    });
    process.stdout.write(await gitCredential(argv[1] ?? "", input));
    return;
  }
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
      skills: { type: "string", multiple: true },
      "no-bundled-skills": { type: "boolean", default: false },
      "memory-limit-mb": { type: "string" },
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

  // Cloud threads: git asks the control plane for short-lived tokens, and the branch is
  // pushed after every turn. The variables reach git and the agent through our environment.
  const cloudGit = Boolean(values["control-plane"] && values.repo && !values["no-git"]);
  if (cloudGit) {
    process.env.LEMONLIME_THREAD_ID = id;
    process.env.LEMONLIME_CONTROL_PLANE_URL = values["control-plane"]!;
  }

  const runner = new ThreadRunner({
    thread,
    workdir,
    dataDir,
    adapter: adapterFor(agent.data!),
    session: { autonomy, ...(values.model ? { model: values.model } : {}), ...(command ? { command } : {}) },
    git: !values["no-git"],
    ...(values.repo ? { repoUrl: values.repo } : {}),
    ...(sourceRepo ? { sourceRepo } : {}),
    checkAgentVersion: true,
    bundledSkills: !values["no-bundled-skills"],
    redact: secretsFromEnv(),
    ...(cloudGit ? { pushBranch: true, credentialHelper: credentialHelperCommand() } : {}),
    ...(values["control-plane"] && secret
      ? { onAgentCredential: (c: AgentCredential) => uploadCredential(values["control-plane"]!, id, agent.data!, secret, c) }
      : {}),
    // The user's own skills (added in the desktop app's settings), then any given here.
    extraSkillDirs: [join(home, "skills"), ...(values.skills ?? []).map(d => resolve(d))],
  });

  const log = (m: string) => process.stderr.write(`[runner ${id}] ${m}\n`);
  // Sign-ins the user made in earlier sandboxes arrive as files to put back in place.
  for (const credential of writeAgentFiles()) runner.useCredential(credential);
  await runner.init();
  const server = await startServer(runner, {
    host: values.host!,
    port,
    threadSecret: secret,
    version: RUNNER_VERSION,
    terminal: { cwd: workdir, spawn: await loadPty() },
  });
  log(`listening on ${values.host}:${server.port} (agent: ${agent.data}, autonomy: ${autonomy})`);
  // Machine-readable line for parent processes (e.g. the desktop app) that asked for port 0.
  process.stdout.write(JSON.stringify({ event: "ready", port: server.port }) + "\n");

  // Local threads share the user's computer; cloud sandboxes have their own hard limit.
  const memoryGuard = sourceRepo
    ? new MemoryGuard({
        ...(values["memory-limit-mb"] ? { limitBytes: Number(values["memory-limit-mb"]) * 1024 * 1024 } : {}),
        onOver: ({ usedBytes, limitBytes, biggest }) => {
          runner.interrupt();
          runner.store.append({
            type: "notice",
            code: "memory_limit",
            message: `Stopped the agent: the programs it started were using ${formatGb(usedBytes)} of memory, more than ${formatGb(limitBytes)} (half this computer's)${biggest ? `, mostly ${biggest.name}` : ""}. Ask it to try a lighter approach, or send a message to carry on.`,
          });
          log(`memory limit: ${formatGb(usedBytes)} used, limit ${formatGb(limitBytes)}`);
        },
        onKilled: p => {
          runner.store.append({
            type: "notice",
            code: "memory_limit_killed",
            message: `${p.name} was still using ${formatGb(p.rss)} after the agent stopped, so it was closed.`,
          });
          log(`memory limit: stopped ${p.name} (${p.pid})`);
        },
      }).start()
    : null;

  const shutdown = async (code = 0) => {
    memoryGuard?.stop();
    // Drain on the way out: one last history upload, bounded so a stop is never held up long.
    if (heartbeat) await Promise.race([heartbeat.beat(), new Promise(r => setTimeout(r, 5000))]);
    heartbeat?.stop();
    await runner.close();
    await server.close();
    process.exit(code);
  };
  const heartbeat = values["control-plane"]
    ? startHeartbeat(runner, {
        controlPlaneUrl: values["control-plane"],
        threadSecret: secret,
        version: RUNNER_VERSION,
        onShutdown: () => void shutdown(0),
        log,
        ownPorts: [server.port],
      })
    : null;

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

/**
 * Files from LEMONLIME_AGENT_FILES (base64 JSON: path under $HOME → content), such as
 * Codex's auth.json, written with owner-only permissions. The variable is then removed so
 * the agent never sees it.
 */
export function writeAgentFiles(env: NodeJS.ProcessEnv = process.env, home = homedir()): AgentCredential[] {
  const raw = env.LEMONLIME_AGENT_FILES;
  delete env.LEMONLIME_AGENT_FILES;
  if (!raw) return [];
  let files: Record<string, string>;
  try {
    files = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, string>;
  } catch {
    return [];
  }
  const out: AgentCredential[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith("/") || path.split("/").includes("..")) continue;
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
    out.push({ kind: "file", name: path, value: content });
  }
  return out;
}

async function uploadCredential(controlPlane: string, threadId: string, agent: string, secret: string, c: AgentCredential): Promise<void> {
  const token = await signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + 120 }, secret);
  const res = await fetch(`${controlPlane.replace(/\/+$/, "")}/api/runner/agent-credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ threadId, agent, kind: c.kind, name: c.name, value: c.value }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    process.stderr.write(`lemonlime-runner: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
