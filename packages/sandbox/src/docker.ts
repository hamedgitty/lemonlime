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
   * this user. The image's `agent` user is the usual choice.
   */
  agentUser?: string;
  /**
   * Reach runners through a reverse proxy instead of published ports: each runner's URL
   * becomes `<publicUrl>/<container name>`, and no port is opened on the host. The proxy
   * must route `/<container name>/…` to `<container name>:<runner port>` on `network`
   * (see docker/Caddyfile).
   */
  publicUrl?: string;
}

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

  async create(o: CreateSandboxOptions): Promise<SandboxInfo> {
    const res = SANDBOX_RESOURCES[o.size];
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
      ...(this.opts.agentUser ? ["--user", "root", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL"] : []),
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
      ...(this.opts.agentUser ? ["lemonlime-runner", "keeper", "--thread", o.threadId, "--agent-user", this.opts.agentUser, "--"] : []),
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
