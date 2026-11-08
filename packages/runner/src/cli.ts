import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  AgentKind,
  branchForThread,
  DEFAULT_BRANCH_PREFIX,
  isSafeBranchPrefix,
  ReasoningLevel,
  deriveAgentKey,
  signToken,
  ThreadId,
  UserSkillList,
  type Thread,
} from "@lemonlime/protocol";
import { adapterFor, type Autonomy } from "./agents/index.ts";
import { killAllAgentGroups } from "./agents/process.ts";
import { runApprovalMcp } from "./approval-mcp.ts";
import { runSubagentsMcp } from "./subagents-mcp.ts";
import { GitWorkspace } from "./git.ts";
import { secretsFromEnv } from "./redact.ts";
import { credentialHelperCommand, gitCredential } from "./git-credential.ts";
import type { AgentCredential } from "./login.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { formatGb, MemoryGuard, prioritizeMemory } from "./memory-guard.ts";
import { loadPty } from "./terminal.ts";
import { startTunnel } from "./tunnel.ts";
import { createInterface } from "node:readline";
import { biggestWriter, DiskGuard, formatBytes } from "./disk-guard.ts";
import { runCommandGuardHook } from "./command-guard.ts";
import { Relay, relayResponse } from "./relay.ts";
import { startServer } from "./server.ts";
import { importHistory, scanHistory } from "./history/index.ts";
import { ThreadRunner } from "./thread-runner.ts";
import { RUNNER_VERSION } from "./version.ts";

// Output piped into something that stops reading early (`lemonlime-runner --help | head`):
// stop quietly instead of crashing with a stack trace. 141 is what a shell reports for a
// closed pipe, and being non-zero, a service manager still restarts a runner that hit it.
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(141);
    throw err;
  });

const HELP = `lemonlime-runner — run one coding agent and stream its work

Usage: lemonlime-runner --thread <id> --agent <kind> [options]
       lemonlime-runner cleanup --thread <id> --source-repo <path>
                        Remove a local thread's worktree (its branch and commits stay)
                        and its local history
       lemonlime-runner history scan [--since-days <n>] [--limit <n>]
                        Summarise the Claude Code, Codex and OpenCode conversations
                        saved on this computer, as JSON (they are only read)
       lemonlime-runner history import <id>...
                        Make local threads from conversations a scan listed, as JSON

  --thread <id>            Thread id (required)
  --agent <kind>           claude-code | codex | opencode | acp (required)
  --agent-command <cmd>    Command for ACP agents, e.g. "gemini --experimental-acp"
  --model <name>           Model to ask the agent for
  --reasoning <level>      How hard it thinks: low, medium, high (Codex also xhigh, max)
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
  --relay                  The sandbox can't reach the control plane: keep its calls for
                           the control plane to collect (it fetches them every minute)
  --autonomy <level>       full | edits (default: full inside a sandbox, otherwise edits)
  --skills <dir>           Also copy the skill folders in <dir> into the thread (repeatable).
                           Skills in ~/.lemonlime/skills are always copied too.
  --no-bundled-skills      Don't copy LemonLime's own skills into the thread
  --plugins-dir <dir>      Agent plugins folder (plugins.json + one folder per plugin; the
                           desktop app passes ~/.lemonlime/plugins). Enabled plugins add
                           skills for every agent, commands and subagents for Claude Code,
                           and MCP servers for Claude Code and Codex. Hooks are never run.
  --disable-skills <names> Leave these bundled skills out (comma-separated, repeatable),
                           e.g. lemonlime-open-pr,lemonlime-previews
  --no-command-guard       Let the agent run commands that wipe the computer or home
                           folder, erase disks or fork-bomb (blocked by default: Claude Code
                           through a hook, OpenCode and other ACP agents when they ask
                           before running a command)
  --instructions-file <path>
                           Your own instructions, added to every turn (Claude Code's system
                           prompt, Codex's developer instructions, the first message of each
                           new ACP conversation). At most 32 KB; longer is cut short.
  --strip-coauthors        Remove Co-authored-by trailers from commits the agent makes in
                           the thread (a commit-msg hook for the thread only; the
                           repository's own hooks still run and are never changed)
  --branch-prefix <prefix> Name the thread's branch <prefix><thread> (default: agent/).
                           A thread keeps the branch it started on.
  --retry-max-wait <min>   When a turn fails because the AI provider is overloaded or a
                           usage limit was hit, try it again (at the time the agent gives,
                           or after a growing wait), waiting at most this many minutes in
                           all. Sending a message or stopping the agent cancels the wait.
                           0 (the default) turns it off; a usage limit then still continues
                           the thread once it resets.
  --memory-limit-mb <n>    Local threads: stop the agent when what it started uses more
                           than this much memory (default: half the computer's)
  --no-git                 Don't manage a branch or commit changes
  -h, --help               Show this help

Environment:
  LEMONLIME_THREAD_SECRET  The thread's secret (required)
  LEMONLIME_HOME           Where worktrees and local history live (default: ~/.lemonlime)
  LEMONLIME_REDACT_ENV     Comma-separated names of variables holding secrets; their
                           values are removed from every event
  LEMONLIME_INSTRUCTIONS   Instructions, as with --instructions-file (the file wins)
  LEMONLIME_STRIP_COAUTHORS=1          Same as --strip-coauthors
  LEMONLIME_RETRY_MAX_WAIT=<minutes>   Same as --retry-max-wait (the flag wins)
  LEMONLIME_USER_SKILLS_0, _1, ...     Skills to add to ~/.lemonlime/skills before starting:
                           gzip-compressed JSON [{"name","files":{path: content}}] in
                           base64, split over numbered variables (cloud sandboxes)
  LEMONLIME_SETUP_LOG      Output of the sandbox's setup script, shown in the thread once
`;

/** Most bytes of instructions an agent gets. */
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;

/** Cut text to at most `max` UTF-8 bytes, never in the middle of a character. */
export function capBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  return bytes.subarray(0, max).toString("utf8").replace(/�$/, "");
}

/** The user's instructions: --instructions-file, else LEMONLIME_INSTRUCTIONS; capped. */
export function readInstructions(file: string | undefined, env: NodeJS.ProcessEnv = process.env): { text: string; cut: boolean } | null {
  const raw = file ? readFileSync(file, "utf8") : env.LEMONLIME_INSTRUCTIONS;
  delete env.LEMONLIME_INSTRUCTIONS;
  if (!raw?.trim()) return null;
  const text = capBytes(raw, INSTRUCTIONS_MAX_BYTES);
  return { text, cut: text.length < raw.length };
}

/**
 * The thread's branch. A thread keeps the branch it started on (saved in its data folder),
 * so changing the prefix later never moves an existing thread to a new branch. Threads
 * from before branch names were saved used the default prefix.
 */
export function threadBranch(dataDir: string, id: ThreadId, prefix: string | undefined): string {
  const file = join(dataDir, "branch");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }
  const existing = existsSync(join(dataDir, "state.json")) || existsSync(join(dataDir, "events.jsonl"));
  if (existing || prefix === undefined || prefix === DEFAULT_BRANCH_PREFIX) return branchForThread(id);
  const branch = branchForThread(id, prefix);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${branch}\n`);
  return branch;
}

/**
 * Skills from LEMONLIME_USER_SKILLS_<n> (see HELP), written into `skillsDir`, replacing any
 * skill of the same name. The variables are then removed so the agent never sees them.
 * Returns the names written.
 */
export function writeUserSkills(skillsDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const parts: string[] = [];
  for (let i = 0; env[`LEMONLIME_USER_SKILLS_${i}`] !== undefined; i++) {
    parts.push(env[`LEMONLIME_USER_SKILLS_${i}`]!);
    delete env[`LEMONLIME_USER_SKILLS_${i}`];
  }
  if (!parts.length) return [];
  const parsed = UserSkillList.safeParse(JSON.parse(gunzipSync(Buffer.from(parts.join(""), "base64")).toString("utf8")));
  if (!parsed.success) throw new Error(`the workspace's skills are not valid: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
  for (const skill of parsed.data) {
    const dir = join(skillsDir, skill.name);
    rmSync(dir, { recursive: true, force: true });
    for (const [path, content] of Object.entries(skill.files)) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  return parsed.data.map(s => s.name);
}

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

/** Set once main() has run: bundled into one file, both the entry check below and the bundle's own entry can call it. */
let mainStarted = false;

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (mainStarted) return;
  mainStarted = true;
  // `pnpm runner -- --help` passes the `--` along; it isn't an argument.
  const argv = args[0] === "--" ? args.slice(1) : args;
  if (argv[0] === "cleanup") return cleanup(argv.slice(1));
  if (argv[0] === "history") return historyCommand(argv.slice(1));
  if (argv[0] === "approval-mcp") return runApprovalMcp();
  if (argv[0] === "subagents-mcp") return runSubagentsMcp();
  if (argv[0] === "preview") return previewCommand(argv.slice(1));
  if (argv[0] === "tunnel") return tunnelCommand(argv.slice(1));
  if (argv[0] === "command-guard") {
    const input = await new Promise<string>(resolve => {
      let data = "";
      process.stdin.on("data", d => (data += d));
      process.stdin.on("end", () => resolve(data));
    });
    const verdict = runCommandGuardHook(input);
    if (verdict.stderr) process.stderr.write(`${verdict.stderr}\n`);
    process.exit(verdict.code);
  }
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
      reasoning: { type: "string" },
      workdir: { type: "string" },
      "source-repo": { type: "string" },
      repo: { type: "string" },
      base: { type: "string", default: "main" },
      port: { type: "string", default: process.env.LEMONLIME_RUNNER_PORT ?? "7420" },
      host: { type: "string", default: "127.0.0.1" },
      "data-dir": { type: "string" },
      "control-plane": { type: "string" },
      relay: { type: "boolean", default: false },
      autonomy: { type: "string" },
      "no-git": { type: "boolean", default: false },
      skills: { type: "string", multiple: true },
      "no-bundled-skills": { type: "boolean", default: false },
      "plugins-dir": { type: "string" },
      "memory-limit-mb": { type: "string" },
      "no-command-guard": { type: "boolean", default: false },
      "instructions-file": { type: "string" },
      "strip-coauthors": { type: "boolean", default: false },
      "branch-prefix": { type: "string" },
      "retry-max-wait": { type: "string" },
      "disable-skills": { type: "string", multiple: true },
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
  // The agent and everything it starts inherit this process's environment. It gets a key
  // derived from the secret instead of the secret itself: enough for its own tools
  // (previews, subagents, computer access, git credentials), not enough to act as the
  // user or as this runner.
  const agentKey = await deriveAgentKey(secret);
  const redactions = { ...secretsFromEnv(), LEMONLIME_AGENT_KEY: agentKey };
  delete process.env.LEMONLIME_THREAD_SECRET;
  process.env.LEMONLIME_AGENT_KEY = agentKey;
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

  const branchPrefix = values["branch-prefix"];
  if (branchPrefix !== undefined && !isSafeBranchPrefix(branchPrefix)) fail("--branch-prefix must be a safe git branch prefix, e.g. agent/ or ai-");
  const retryMinutes = Number(values["retry-max-wait"] ?? process.env.LEMONLIME_RETRY_MAX_WAIT ?? 0);
  if (!Number.isFinite(retryMinutes) || retryMinutes < 0) fail("--retry-max-wait must be a number of minutes (0 turns it off)");
  delete process.env.LEMONLIME_RETRY_MAX_WAIT;
  const stripCoauthors = values["strip-coauthors"] || process.env.LEMONLIME_STRIP_COAUTHORS === "1";
  delete process.env.LEMONLIME_STRIP_COAUTHORS;
  const disabledSkills = (values["disable-skills"] ?? [])
    .flatMap(v => v.split(","))
    .map(s => s.trim())
    .filter(Boolean);
  let instructions: ReturnType<typeof readInstructions> = null;
  try {
    instructions = readInstructions(values["instructions-file"]);
  } catch (err) {
    fail(`could not read --instructions-file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const setupLog = process.env.LEMONLIME_SETUP_LOG;
  delete process.env.LEMONLIME_SETUP_LOG;
  // The workspace's own skills (cloud sandboxes), next to the user's own ones.
  try {
    writeUserSkills(join(home, "skills"));
  } catch (err) {
    process.stderr.write(`[runner ${id}] could not add the workspace's skills: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const reasoning = values.reasoning && ReasoningLevel.safeParse(values.reasoning).success ? (values.reasoning as ReasoningLevel) : undefined;
  const thread: Thread = {
    id,
    title: "",
    agent: { kind: agent.data!, ...(command ? { command } : {}), ...(values.model ? { model: values.model } : {}), ...(reasoning ? { reasoning } : {}) },
    repo: { url: values.repo ?? sourceRepo ?? workdir, baseBranch: values.base! },
    branch: values["no-git"] ? branchForThread(id, branchPrefix) : threadBranch(dataDir, id, branchPrefix),
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
  // Relay mode: this sandbox can't reach the control plane, so the control plane collects
  // the runner's calls from it instead (see relay.ts).
  const relay = values.relay && values["control-plane"] ? new Relay() : null;
  if (relay) process.env.LEMONLIME_RELAY = "1";

  const runner = new ThreadRunner({
    thread,
    workdir,
    dataDir,
    adapter: adapterFor(agent.data!),
    session: {
      autonomy,
      ...(values.model ? { model: values.model } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(command ? { command } : {}),
      ...(values["no-command-guard"] ? { commandGuard: false } : {}),
      ...(instructions ? { instructions: instructions.text } : {}),
    },
    stripCoauthors,
    disabledSkills,
    retryMaxWaitMs: Math.round(retryMinutes * 60_000),
    ...(setupLog ? { setupLog } : {}),
    git: !values["no-git"],
    ...(values.repo ? { repoUrl: values.repo } : {}),
    ...(sourceRepo ? { sourceRepo } : {}),
    checkAgentVersion: true,
    bundledSkills: !values["no-bundled-skills"],
    redact: redactions,
    ...(cloudGit ? { pushBranch: true, credentialHelper: credentialHelperCommand() } : {}),
    ...(values["control-plane"] && secret
      ? { onAgentCredential: (c: AgentCredential) => uploadCredential(values["control-plane"]!, id, agent.data!, secret, c, relay) }
      : {}),
    // The user's own skills (added in the desktop app's settings), then any given here.
    extraSkillDirs: [join(home, "skills"), ...(values.skills ?? []).map(d => resolve(d))],
    ...(values["plugins-dir"] ? { pluginsDir: resolve(values["plugins-dir"]) } : {}),
  });

  const log = (m: string) => process.stderr.write(`[runner ${id}] ${m}\n`);
  // Sign-ins the user made in earlier sandboxes arrive as files to put back in place.
  for (const credential of writeAgentFiles()) runner.useCredential(credential);
  await runner.init();
  if (instructions?.cut) log(`instructions were longer than ${INSTRUCTIONS_MAX_BYTES / 1024} KB, so only the start is used`);
  const server = await startServer(runner, {
    host: values.host!,
    port,
    threadSecret: secret,
    version: RUNNER_VERSION,
    terminal: { cwd: workdir, spawn: await loadPty() },
    ownPorts: [port],
    ...(relay ? { relay } : {}),
  });
  log(`listening on ${values.host}:${server.port} (agent: ${agent.data}, autonomy: ${autonomy})`);
  // For the agent's own `lemonlime-runner preview`: where this runner is, and which thread.
  process.env.LEMONLIME_RUNNER_URL = `http://127.0.0.1:${server.port}`;
  // Cloud agents can ask for the user's own computer (their desktop app decides).
  if (inSandbox) process.env.LEMONLIME_COMPUTER_TOOLS = "1";
  process.env.LEMONLIME_THREAD_ID = id;
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

  const notice = (code: string, message: string) => runner.store.append({ type: "notice", code, message });
  const diskGuard = new DiskGuard({
    path: workdir,
    onWarn: s => notice("disk_low", `The disk is getting full: ${formatBytes(s.freeBytes)} left. Builds and git start failing when it runs out.`),
    onPause: s => {
      runner.hold("disk_full");
      notice(
        "disk_full",
        `Paused the agent: only ${formatBytes(s.freeBytes)} of disk space is left. It carries on, with any messages you send, once there's more room. Deleting build output or caches is usually enough.`,
      );
      log(`disk nearly full (${formatBytes(s.freeBytes)} free): agent paused`);
    },
    onResume: s => {
      notice("disk_ok", `There's room again (${formatBytes(s.freeBytes)} free), so the agent carries on.`);
      runner.release();
    },
    onStillFull: async () => {
      const w = await biggestWriter();
      if (!w) return;
      try {
        process.kill(w.pid, "SIGTERM");
        notice("disk_full_killed", `${w.name} kept filling the disk after the agent paused (it wrote ${formatBytes(w.writtenBytes)}), so it was closed.`);
      } catch {
        /* already gone */
      }
    },
  }).start();

  const oomTimer = process.platform === "linux" ? setInterval(() => void prioritizeMemory().catch(() => 0), 15_000) : null;
  oomTimer?.unref();

  const shutdown = async (code = 0) => {
    if (oomTimer) clearInterval(oomTimer);
    diskGuard.stop();
    memoryGuard?.stop();
    // Drain on the way out: one last history upload, bounded so a stop is never held up long.
    if (heartbeat) await Promise.race([heartbeat.beat(), new Promise(r => setTimeout(r, 5000))]);
    heartbeat?.stop();
    await runner.close();
    await server.close();
    // Shells, builds and dev servers the agent started go too, not just the agent.
    killAllAgentGroups();
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
        ...(relay ? { relay } : {}),
      })
    : null;

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  // Agents run in their own process groups, which would outlive a runner that dies another way.
  process.on("exit", () => killAllAgentGroups());
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

async function uploadCredential(controlPlane: string, threadId: string, agent: string, secret: string, c: AgentCredential, relay: Relay | null): Promise<void> {
  // Relayed calls can wait a few minutes for the control plane, so the token lives longer.
  const token = await signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + (relay ? 300 : 120) }, secret);
  const body = { threadId, agent, kind: c.kind, name: c.name, value: c.value };
  const res = relay
    ? relayResponse(await relay.request({ method: "POST", path: "/api/runner/agent-credentials", authorization: `Bearer ${token}`, body }))
    : await fetch(`${controlPlane.replace(/\/+$/, "")}/api/runner/agent-credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
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

const HISTORY_USAGE = "usage: lemonlime-runner history scan [--since-days <n>] [--limit <n>] | history import <id>...";

/**
 * `lemonlime-runner history scan|import`: read other agents' saved conversations (never
 * changing them) and turn chosen ones into local threads. Prints one JSON object.
 */
export async function historyCommand(argv: string[], write: (text: string) => void = t => void process.stdout.write(t)): Promise<void> {
  const [sub, ...rest] = argv;
  const home = lemonlimeHome();
  if (sub === "scan") {
    const { values } = parseArgs({
      args: rest,
      options: { "since-days": { type: "string", default: "30" }, limit: { type: "string", default: "200" } },
      strict: true,
    });
    const sinceDays = Number(values["since-days"]);
    const limit = Number(values.limit);
    if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 3650) throw new Error("--since-days must be a whole number of days, 1 to 3650");
    if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a whole number");
    write(JSON.stringify(await scanHistory({ sinceDays, limit, lemonlimeHome: home })) + "\n");
    return;
  }
  if (sub === "import") {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {}, strict: true });
    if (!positionals.length) throw new Error(HISTORY_USAGE);
    write(JSON.stringify(await importHistory({ ids: positionals, lemonlimeHome: home })) + "\n");
    return;
  }
  throw new Error(HISTORY_USAGE);
}

const isEntry = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts");
if (isEntry) {
  main().catch(err => {
    process.stderr.write(`lemonlime-runner: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}

/**
 * `lemonlime-runner preview <port> [--name <what>] [--remove]`: run by the agent after it
 * starts a dev server, so the user can open it. Talks to this thread's runner.
 */
async function previewCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { name: { type: "string" }, remove: { type: "boolean", default: false } },
  });
  const port = Number(positionals[0]);
  const base = process.env.LEMONLIME_RUNNER_URL;
  const threadId = process.env.LEMONLIME_THREAD_ID;
  const key = process.env.LEMONLIME_AGENT_KEY;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("usage: lemonlime-runner preview <port> [--name <what it is>] [--remove]");
  if (!base || !threadId || !key) throw new Error("Run this from inside a LemonLime thread (the runner sets LEMONLIME_RUNNER_URL).");
  const token = await signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + 60 }, key);
  const res = await fetch(`${base}/previews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ port, name: values.name ?? "", remove: values.remove }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `runner answered ${res.status}`);
  process.stdout.write(
    values.remove
      ? `Port ${port} is no longer offered for preview.\n`
      : `Port ${port} is ready to preview in LemonLime${values.name ? ` as "${values.name}"` : ""}.\n`,
  );
}

/**
 * `lemonlime-runner tunnel --url <runner ws url> --port <preview port> [--local-port <n>]`:
 * started by the desktop app to show a cloud preview on 127.0.0.1. Client tokens arrive on
 * stdin, one JSON line each ({"token": "..."}), and the newest is used for new connections.
 */
async function tunnelCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { url: { type: "string" }, port: { type: "string" }, "local-port": { type: "string", default: "0" } } });
  if (!values.url || !values.port) throw new Error("usage: lemonlime-runner tunnel --url <runner ws url> --port <n> [--local-port <n>]");
  let token = "";
  const lines = createInterface({ input: process.stdin });
  const first = new Promise<void>(resolve => {
    lines.on("line", line => {
      try {
        const t = (JSON.parse(line) as { token?: string }).token;
        if (t) token = t;
      } catch {
        /* ignore */
      }
      if (token) resolve();
    });
  });
  lines.on("close", () => process.exit(0)); // the app went away
  await first;
  const tunnel = await startTunnel({ runnerUrl: values.url, port: Number(values.port), localPort: Number(values["local-port"]), token: () => token });
  process.stdout.write(JSON.stringify({ event: "listening", port: tunnel.port }) + "\n");
}
