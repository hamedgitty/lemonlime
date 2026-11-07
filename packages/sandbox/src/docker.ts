import { SANDBOX_RESOURCES } from "@lemonlime/protocol";
import type { CreateSandboxOptions, RunnerLaunch, SandboxInfo, SandboxProvider, SandboxState } from "./types.ts";

type Run = (file: string, args: string[], opts: { maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
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

  private async exec(args: string[]): Promise<string> {
    const run = await loadRun();
    const { stdout } = await run(this.docker, args, { maxBuffer: 4 * 1024 * 1024 });
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
      ...(this.opts.publicUrl ? [] : ["-p", `${this.bindHost}::${o.runner.port}`]),
      ...(this.opts.network ? ["--network", this.opts.network] : []),
      "--label",
      `lemonlime.runner-port=${o.runner.port}`,
      ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
      ...Object.entries(o.runner.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      this.opts.image,
      "sh",
      "-c",
      o.runner.command,
    ];
    const id = await this.exec(args);
    return this.info(id, o.runner.port);
  }

  async get(id: string): Promise<SandboxInfo | null> {
    try {
      const port = await this.exec(["inspect", "-f", '{{index .Config.Labels "lemonlime.runner-port"}}', id]);
      return await this.info(id, Number(port) || 7420);
    } catch {
      return null;
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

function ignoreMissing(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/No such container/i.test(msg)) throw err;
}
