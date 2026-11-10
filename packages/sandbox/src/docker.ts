import { SANDBOX_RESOURCES } from "@lemonlime/protocol";
import { launchCommand, type CreateSandboxOptions, type RunnerLaunch, type SandboxInfo, type SandboxProvider, type SandboxState } from "./types.ts";

type Run = (file: string, args: string[], opts: { maxBuffer: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
let runner: Promise<Run> | undefined;

/**
 * Loads `child_process` on first use, so importing this package never fails on
 * runtimes without it (Cloudflare Workers). Docker itself needs Node.
 */
function loadRun(): Promise<Run> {
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers") {
    return Promise.reject(
      new Error("The docker sandbox provider needs Node.js next to a Docker daemon and cannot run on Cloudflare Workers. Use daytona or e2b there."),
    );
  }
  runner ??= Promise.all([import("node:child_process"), import("node:util")]).then(([cp, util]) => util.promisify(cp.execFile) as unknown as Run);
  return runner;
}

export interface DockerProviderOptions {
  /** Image with the runner and agent CLIs installed. */
  image: string;
  /** Path to the docker binary. */
  docker?: string;
  /** Host interface the runner port is published on (when `publicUrl` is not set). */
  bindHost?: string;
  /** Docker network to attach sandboxes to, e.g. the one a reverse proxy shares. */
  network?: string;
  /**
   * Run the agent as this user, apart from the thread secret: the container starts as root,
   * a keeper (`lemonlime-runner keeper`) keeps the secret and starts everything else as
   * this user. Left out, the image's `agent` user is used when the image can do this, and
   * an image that can't starts the runner as the image's own user with the secret in its
   * environment, after one warning. A user named here must work in the image: creating a
   * sandbox fails when it doesn't. `false` turns the separate user off.
   */
  agentUser?: string | false;
  /** Where warnings go. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Reach runners through a reverse proxy instead of published ports: each runner's URL
   * becomes `<publicUrl>/<container name>`, and no port is opened on the host. The proxy
   * must route `/<container name>/…` to `<container name>:<runner port>` on `network`
   * (see docker/Caddyfile).
   */
  publicUrl?: string;
}

/** The user the stock sandbox image runs the agent as. */
const DEFAULT_AGENT_USER = "agent";

/** What trying the keeper in an image found: it works, or why it doesn't. */
type KeeperCheck = { ok: true } | { ok: false; why: string; noUser: boolean };

/**
 * What each image answered, by docker binary, image id and user, so an image is tried once
 * and a rebuilt one (a new id under the same tag) is tried again.
 */
const keeperChecks = new Map<string, KeeperCheck>();
/** Images already warned about, so the warning is logged once and not for every thread. */
const warned = new Set<string>();

/** Container name for a thread's sandbox. Also the path segment behind a proxy. */
export function containerName(threadId: string): string {
  return `lemonlime-${threadId}`;
}

/**
 * Runs each sandbox as a local Docker container. Good for development and for
 * self-hosters with their own servers. "Pause" stops the container (no CPU use,
 * files kept); "resume" starts it again, which re-runs the runner command.
 */
export class DockerProvider implements SandboxProvider {
  readonly name = "docker";
  private readonly docker: string;
  private readonly bindHost: string;

  constructor(private readonly opts: DockerProviderOptions) {
    this.docker = opts.docker ?? "docker";
    this.bindHost = opts.bindHost ?? "127.0.0.1";
  }

  private async exec(args: string[], env?: Record<string, string>): Promise<string> {
    const run = await loadRun();
    const { stdout } = await run(this.docker, args, { maxBuffer: 4 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
    return stdout.trim();
  }

  /**
   * The user the keeper starts the agent as in a new sandbox, or null to start the runner
   * as the image's own user with the thread secret in its environment.
   */
  private async agentUserFor(): Promise<string | null> {
    if (this.opts.agentUser === false) return null;
    const named = this.opts.agentUser;
    const user = named ?? DEFAULT_AGENT_USER;
    const check = await this.checkKeeper(user);
    if (check.ok) return user;
    if (named) {
      throw new Error(
        check.noUser
          ? `The sandbox image ${this.opts.image} has no user called "${named}". Set LEMONLIME_DOCKER_AGENT_USER to a user the image has (the stock image has "agent"), or to "none" to run the agent as the image's own user.`
          : `The sandbox image ${this.opts.image} can't run the agent as "${named}": ${check.why}. Rebuild the image from docker/sandbox.Dockerfile, or set LEMONLIME_DOCKER_AGENT_USER=none to run the agent as the image's own user.`,
      );
    }
    const key = `${this.docker}\n${this.opts.image}`;
    if (!warned.has(key)) {
      warned.add(key);
      (this.opts.warn ?? console.warn)(
        `The sandbox image ${this.opts.image} can't run the agent as a separate "${DEFAULT_AGENT_USER}" user (${check.why}), so the thread secret is in the runner's environment, where the agent can read it. Rebuild the image from docker/sandbox.Dockerfile to keep the secret away from the agent, or set LEMONLIME_DOCKER_AGENT_USER=none to stop this warning.`,
      );
    }
    return null;
  }

  /**
   * Try the keeper in the image, once per image: a throwaway container with no network
   * starts the keeper as root with a made-up secret and has it run `true` as `user`. That
   * finds a missing user, a runner without a keeper and a keeper that can't switch user,
   * the same way, before a thread depends on it. Docker's own failures (no daemon, no such
   * image) are thrown, as they would be when starting the sandbox.
   */
  private async checkKeeper(user: string): Promise<KeeperCheck> {
    const imageId = () => this.exec(["image", "inspect", "-f", "{{.Id}}", this.opts.image]).catch(() => "");
    const key = (id: string) => `${this.docker}\n${id}\n${user}`;
    const known = await imageId();
    const cached = known ? keeperChecks.get(key(known)) : undefined;
    if (cached) return cached;
    let check: KeeperCheck;
    try {
      await this.exec([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "root",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        ...KEEPER_CAPS,
        "-e",
        "LEMONLIME_THREAD_SECRET=keeper-check-not-a-secret",
        this.opts.image,
        "lemonlime-runner",
        "keeper",
        "--thread",
        "keeper-check",
        "--agent-user",
        user,
        "--",
        "true",
      ]);
      check = { ok: true };
    } catch (err) {
      const failure = err as { code?: unknown; stderr?: unknown };
      // 125 is docker itself failing; no exit code at all means docker never ran.
      if (typeof failure.code !== "number" || failure.code === 125) throw err;
      const lines = String(failure.stderr ?? "")
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
      const noUser = lines.find(l => /no user called/i.test(l));
      const why = noUser
        ? `it has no user called "${user}"`
        : failure.code === 127 || failure.code === 126
          ? "it has no lemonlime-runner command"
          : "its runner is too old to keep the thread secret apart";
      check = { ok: false, why, noUser: Boolean(noUser) };
    }
    // The image may have been pulled by the try above, so its id is looked up again.
    const id = known || (await imageId());
    if (id) keeperChecks.set(key(id), check);
    return check;
  }

  async create(o: CreateSandboxOptions): Promise<SandboxInfo> {
    const res = SANDBOX_RESOURCES[o.size];
    const agentUser = await this.agentUserFor();
    const labels = { "lemonlime.thread": o.threadId, ...o.labels };
    const args = [
      "run",
      "-d",
      "--name",
      containerName(o.threadId),
      "--cpus",
      String(res.vcpu),
      "--memory",
      `${res.memoryGiB}g`,
      "--restart",
      "no",
      // The agent runs as a normal user and needs none of root's powers; a fork bomb
      // shouldn't take the host down with it.
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--pids-limit",
      "1024",
      // With a separate agent user, root keeps only what the keeper needs: switching to that
      // user and stopping its processes.
      ...(agentUser ? ["--user", "root", ...KEEPER_CAPS] : []),
      // A small init as process 1 reaps what the agent's processes leave behind, so finished
      // ones don't pile up toward the process limit.
      "--init",
      ...(this.opts.publicUrl ? [] : ["-p", `${this.bindHost}::${o.runner.port}`]),
      ...(this.opts.network ? ["--network", this.opts.network] : []),
      "--label",
      `lemonlime.runner-port=${o.runner.port}`,
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      // Names only: docker takes each value from its own environment, so secrets never
      // appear in the host's process list.
      ...Object.keys(o.runner.env).flatMap(k => ["-e", k]),
      this.opts.image,
      ...(agentUser ? ["lemonlime-runner", "keeper", "--thread", o.threadId, "--agent-user", agentUser, "--"] : []),
      "sh",
      "-c",
      launchCommand(o.runner),
    ];
    let id: string;
    try {
      id = await this.exec(args, o.runner.env);
    } catch (err) {
      // Docker can make the container and then fail to start it. Left behind, it would keep
      // the name and block the next try. A container that already had the name is not ours.
      if (!nameTaken(err)) await this.removeUnstarted(containerName(o.threadId));
      throw err;
    }
    try {
      return await this.info(id, o.runner.port);
    } catch (err) {
      // The caller never learns this id, so clean up rather than leave it running.
      await this.exec(["rm", "-f", id]).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Remove a container docker made but never started. One that has run is a thread's
   * sandbox with its files in it, and is never removed here.
   */
  private async removeUnstarted(name: string): Promise<void> {
    const status = await this.exec(["inspect", "-f", "{{.State.Status}}", name]).catch(() => "");
    if (status === "created") await this.exec(["rm", "-f", name]).catch(() => undefined);
  }

  async get(id: string): Promise<SandboxInfo | null> {
    try {
      const port = await this.exec(["inspect", "-f", '{{index .Config.Labels "lemonlime.runner-port"}}', id]);
      return await this.info(id, Number(port) || 7420);
    } catch (err) {
      // Gone only when docker says so. Anything else, such as docker not answering, is an error.
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async pause(id: string): Promise<void> {
    await this.exec(["stop", "-t", "10", id]).catch(ignoreMissing);
  }

  async resume(id: string, runner: RunnerLaunch): Promise<SandboxInfo> {
    await this.exec(["start", id]);
    return this.info(id, runner.port);
  }

  async destroy(id: string): Promise<void> {
    await this.exec(["rm", "-f", id]).catch(ignoreMissing);
  }

  private async info(id: string, port: number): Promise<SandboxInfo> {
    const status = await this.exec(["inspect", "-f", "{{.State.Status}}", id]);
    const state = mapDockerState(status);
    let runnerUrl: string | null = null;
    if (state === "running" && this.opts.publicUrl) {
      const name = (await this.exec(["inspect", "-f", "{{.Name}}", id])).replace(/^\//, "");
      runnerUrl = `${this.opts.publicUrl.replace(/\/+$/, "")}/${name}`;
    } else if (state === "running") {
      const mapped = await this.exec(["port", id, `${port}/tcp`]).catch(() => "");
      const first = mapped.split("\n")[0]?.trim();
      if (first) runnerUrl = `http://${first.replace(/^0\.0\.0\.0/, "127.0.0.1")}`;
    }
    return { id: id.slice(0, 12), provider: this.name, state, runnerUrl };
  }
}

/** What root keeps for the keeper: switching to the agent's user and stopping its processes. */
const KEEPER_CAPS = ["--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL"];

export function mapDockerState(status: string): SandboxState {
  switch (status.trim()) {
    case "created":
    case "restarting":
      return "starting";
    case "running":
      return "running";
    case "paused":
    case "exited":
      return "paused";
    case "dead":
      return "error";
    case "removing":
      return "stopped";
    default:
      return "unknown";
  }
}

const said = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Docker's answer for a container that isn't there ("No such container", or "no such object" from inspect). */
function isMissing(err: unknown): boolean {
  return /no such (container|object)/i.test(said(err));
}

/** Docker's answer when another container already has the name. */
function nameTaken(err: unknown): boolean {
  return /is already in use/i.test(said(err));
}

function ignoreMissing(err: unknown): void {
  if (!isMissing(err)) throw err;
}
