import { Daytona, type Sandbox } from "@daytonaio/sdk";
import { SANDBOX_RESOURCES } from "@lemonlime/protocol";
import type { CreateSandboxOptions, RunnerLaunch, SandboxInfo, SandboxProvider, SandboxState } from "./types.ts";

export interface DaytonaProviderOptions {
  apiKey: string;
  apiUrl?: string;
  /** Image with the runner and agent CLIs installed. */
  image: string;
  /**
   * Provider-side safety net, in minutes. The control plane already pauses idle
   * threads after 5 minutes; this only catches sandboxes the control plane lost
   * track of. Keep it well above the longest expected agent turn.
   */
  autoStopMinutes?: number;
  /** Archive stopped sandboxes after this many minutes, so their disk stops costing money. */
  autoArchiveMinutes?: number;
}

const RUNNER_SESSION = "lemonlime-runner";

/** Runs each sandbox on Daytona. Billing is per second while running; stopped sandboxes only keep disk. */
export class DaytonaProvider implements SandboxProvider {
  readonly name = "daytona";
  private readonly client: Daytona;

  constructor(private readonly opts: DaytonaProviderOptions) {
    this.client = new Daytona({ apiKey: opts.apiKey, ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}) });
  }

  async create(o: CreateSandboxOptions): Promise<SandboxInfo> {
    const res = SANDBOX_RESOURCES[o.size];
    const sandbox = await this.client.create({
      image: this.opts.image,
      resources: { cpu: res.vcpu, memory: res.memoryGiB, disk: res.diskGiB },
      envVars: o.runner.env,
      labels: { "lemonlime.thread": o.threadId, ...o.labels },
      // The runner checks a signed token on every connection, so the port can be public.
      public: true,
      autoStopInterval: this.opts.autoStopMinutes ?? 60,
      autoArchiveInterval: this.opts.autoArchiveMinutes ?? 24 * 60,
    });
    await this.startRunner(sandbox, o.runner);
    return this.info(sandbox, o.runner.port);
  }

  async get(id: string): Promise<SandboxInfo | null> {
    try {
      const sandbox = await this.client.get(id);
      return await this.info(sandbox, null);
    } catch {
      return null;
    }
  }

  async pause(id: string): Promise<void> {
    const sandbox = await this.client.get(id).catch(() => null);
    if (!sandbox) return;
    if (mapDaytonaState(String(sandbox.state ?? "")) === "running") await sandbox.stop();
  }

  async resume(id: string, runner: RunnerLaunch): Promise<SandboxInfo> {
    const sandbox = await this.client.get(id);
    if (mapDaytonaState(String(sandbox.state ?? "")) !== "running") await sandbox.start(120);
    // Stopping a Daytona sandbox ends its processes, so start the runner again.
    await this.startRunner(sandbox, runner);
    return this.info(sandbox, runner.port);
  }

  async destroy(id: string): Promise<void> {
    const sandbox = await this.client.get(id).catch(() => null);
    if (sandbox) await sandbox.delete();
  }

  private async startRunner(sandbox: Sandbox, runner: RunnerLaunch): Promise<void> {
    await sandbox.process.createSession(RUNNER_SESSION).catch(() => undefined);
    await sandbox.process.executeSessionCommand(RUNNER_SESSION, { command: runner.command, runAsync: true });
  }

  private async info(sandbox: Sandbox, port: number | null): Promise<SandboxInfo> {
    await sandbox.refreshData().catch(() => undefined);
    const state = mapDaytonaState(String(sandbox.state ?? ""));
    let runnerUrl: string | null = null;
    if (state === "running" && port) runnerUrl = (await sandbox.getPreviewLink(port)).url;
    return { id: sandbox.id, provider: this.name, state, runnerUrl };
  }
}

export function mapDaytonaState(state: string): SandboxState {
  switch (state.toLowerCase()) {
    case "creating":
    case "starting":
    case "restoring":
    case "pulling_snapshot":
    case "building_snapshot":
    case "pending_build":
      return "starting";
    case "started":
      return "running";
    case "stopping":
    case "stopped":
    case "archived":
    case "archiving":
    case "paused":
      return "paused";
    case "destroying":
    case "destroyed":
      return "stopped";
    case "error":
    case "build_failed":
      return "error";
    default:
      return "unknown";
  }
}
