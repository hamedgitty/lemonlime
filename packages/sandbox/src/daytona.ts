import { SANDBOX_RESOURCES, type SandboxSize } from "@lemonlime/protocol";
import { defaultFetch, isStatus, requestJson, sleep, trimSlash, type FetchLike } from "./http.ts";
import {
  keeperLaunch,
  launchCommand,
  type CreateSandboxOptions,
  type RunnerLaunch,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxState,
} from "./types.ts";

export interface DaytonaProviderOptions {
  apiKey: string;
  /** Daytona API base URL. Defaults to https://app.daytona.io/api. */
  apiUrl?: string;
  /** Image with the runner and agent CLIs installed. */
  image: string;
  /**
   * Optional Daytona snapshot built from that image, used for every size. When set,
   * sandboxes start from the snapshot (faster) and take their resources from it, so
   * prefer `snapshots`, which keeps each size's CPU and memory.
   */
  snapshot?: string;
  /**
   * Run the agent as this user (the image's `agent`), apart from the thread secret: the
   * sandbox's processes start as root and a keeper starts the runner as this user.
   */
  agentUser?: string;
  /** Optional Daytona snapshot per sandbox size (see `scripts/daytona-snapshots.mjs`). Wins over `snapshot`. */
  snapshots?: Partial<Record<SandboxSize, string>>;
  /**
   * Provider-side safety net, in minutes. The control plane already pauses idle
   * threads after 5 minutes; this only catches sandboxes the control plane lost
   * track of. Keep it well above the longest expected agent turn.
   */
  autoStopMinutes?: number;
  /** Archive stopped sandboxes after this many minutes, so their disk stops costing money. */
  autoArchiveMinutes?: number;
  /** How long to wait for a sandbox to reach "started" on create or resume. Default 2 minutes. */
  startTimeoutMs?: number;
  /** How long to wait for a sandbox to stop on pause. Default 1 minute. */
  stopTimeoutMs?: number;
  /** Delay between state polls. Default 1 second. */
  pollIntervalMs?: number;
  /** Custom fetch, mainly for tests. */
  fetch?: FetchLike;
}

/** The parts of Daytona's Sandbox DTO this provider reads. */
interface DaytonaSandbox {
  id: string;
  state?: string;
  errorReason?: string;
  labels?: Record<string, string>;
  toolboxProxyUrl?: string;
}

const DEFAULT_API_URL = "https://app.daytona.io/api";

function threadOf(sandbox: DaytonaSandbox): string {
  const id = sandbox.labels?.["lemonlime.thread"];
  if (!id) throw new Error(`Daytona sandbox ${sandbox.id} has no thread label, so its keeper can't start`);
  return id;
}
const RUNNER_SESSION = "lemonlime-runner";
const RUNNER_PORT_LABEL = "lemonlime.runner-port";
const FAILED_STATES = new Set(["error", "build_failed"]);

/**
 * Runs each sandbox on Daytona, talking to its REST API with plain `fetch`.
 * Billing is per second while running; stopped sandboxes only keep disk.
 */
export class DaytonaProvider implements SandboxProvider {
  readonly name = "daytona";
  private readonly apiUrl: string;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: DaytonaProviderOptions) {
    this.apiUrl = trimSlash(opts.apiUrl || DEFAULT_API_URL);
    this.fetch = opts.fetch ?? defaultFetch;
  }

  async create(o: CreateSandboxOptions): Promise<SandboxInfo> {
    const res = SANDBOX_RESOURCES[o.size];
    const snapshot = this.opts.snapshots?.[o.size] || this.opts.snapshot;
    const source = snapshot
      ? { snapshot }
      : {
          // What the Daytona SDK sends for `image: "<name>"`: a one-line Dockerfile.
          buildInfo: { dockerfileContent: `FROM ${this.opts.image}\n` },
          cpu: res.vcpu,
          memory: res.memoryGiB,
          disk: res.diskGiB,
        };
    let sandbox = await this.api<DaytonaSandbox>("POST", "/sandbox", {
      ...source,
      // The keeper needs to start as root (see agentUser).
      ...(this.opts.agentUser ? { user: "root" } : {}),
      env: o.runner.env,
      labels: { "lemonlime.thread": o.threadId, ...o.labels },
      // The runner checks a signed token on every connection, so the port can be public.
      public: true,
      autoStopInterval: this.opts.autoStopMinutes ?? 60,
      autoArchiveInterval: this.opts.autoArchiveMinutes ?? 24 * 60,
    });
    try {
      sandbox = await this.waitForStarted(sandbox);
      await this.startRunner(sandbox, o.runner);
      return await this.info(sandbox, o.runner.port);
    } catch (err) {
      // The caller never learns this id, so clean up rather than leave it running.
      await this.destroy(sandbox.id).catch(() => undefined);
      throw err;
    }
  }

  async get(id: string): Promise<SandboxInfo | null> {
    try {
      const sandbox = await this.fetchSandbox(id);
      return await this.info(sandbox, Number(sandbox.labels?.[RUNNER_PORT_LABEL]) || null);
    } catch (err) {
      // Gone only when Daytona says so. Anything else, such as an outage, is an error.
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  async pause(id: string): Promise<void> {
    const sandbox = await this.fetchSandbox(id).catch(() => null);
    if (!sandbox) return;
    if (mapDaytonaState(sandbox.state ?? "") !== "running") return;
    await this.api("POST", `/sandbox/${enc(id)}/stop`);
    await this.waitFor(id, ["stopped", "destroyed", "archived"], this.opts.stopTimeoutMs ?? 60_000, "stop");
  }

  async resume(id: string, runner: RunnerLaunch): Promise<SandboxInfo> {
    let sandbox = await this.fetchSandbox(id);
    const state = (sandbox.state ?? "").toLowerCase();
    if (state === "stopping" || state === "archiving") {
      // Starting mid-transition is rejected, so let it settle first.
      sandbox = await this.waitFor(id, ["stopped", "archived"], this.opts.stopTimeoutMs ?? 60_000, "stop");
    }
    if (mapDaytonaState(sandbox.state ?? "") !== "running") {
      if (mapDaytonaState(sandbox.state ?? "") !== "starting") {
        sandbox = await this.api<DaytonaSandbox>("POST", `/sandbox/${enc(id)}/start`);
      }
      sandbox = await this.waitForStarted(sandbox);
    }
    // Stopping a Daytona sandbox ends its processes, so start the runner again.
    await this.startRunner(sandbox, runner);
    return this.info(sandbox, runner.port);
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.api("DELETE", `/sandbox/${enc(id)}`);
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
    }
  }

  private async startRunner(sandbox: DaytonaSandbox, runner: RunnerLaunch): Promise<void> {
    const base = await this.toolboxUrl(sandbox);
    // The session survives between calls; creating it again just fails, which is fine.
    await this.request("POST", `${base}/process/session`, { sessionId: RUNNER_SESSION }).catch(() => undefined);
    await this.request("POST", `${base}/process/session/${enc(RUNNER_SESSION)}/exec`, {
      command: this.opts.agentUser ? keeperLaunch(threadOf(sandbox), this.opts.agentUser, runner) : launchCommand(runner),
      runAsync: true,
    });
  }

  /** Toolbox API for one sandbox: `<toolboxProxyUrl>/<sandbox id>`, as the SDK builds it. */
  private async toolboxUrl(sandbox: DaytonaSandbox): Promise<string> {
    let proxy = sandbox.toolboxProxyUrl;
    if (!proxy) proxy = (await this.api<{ url: string }>("GET", `/sandbox/${enc(sandbox.id)}/toolbox-proxy-url`)).url;
    return `${trimSlash(proxy)}/${sandbox.id}`;
  }

  private async info(sandbox: DaytonaSandbox, port: number | null): Promise<SandboxInfo> {
    const state = mapDaytonaState(sandbox.state ?? "");
    let runnerUrl: string | null = null;
    if (state === "running" && port) {
      runnerUrl = (await this.api<{ url: string }>("GET", `/sandbox/${enc(sandbox.id)}/ports/${port}/preview-url`)).url;
    }
    return { id: sandbox.id, provider: this.name, state, runnerUrl };
  }

  private fetchSandbox(id: string): Promise<DaytonaSandbox> {
    return this.api<DaytonaSandbox>("GET", `/sandbox/${enc(id)}`);
  }

  private async waitForStarted(sandbox: DaytonaSandbox): Promise<DaytonaSandbox> {
    if ((sandbox.state ?? "").toLowerCase() === "started") return sandbox;
    return this.waitFor(sandbox.id, ["started"], this.opts.startTimeoutMs ?? 120_000, "start");
  }

  /** Polls the sandbox until it reaches one of `targets`, fails, or the timeout passes. */
  private async waitFor(id: string, targets: string[], timeoutMs: number, action: string): Promise<DaytonaSandbox> {
    const deadline = Date.now() + timeoutMs;
    const interval = this.opts.pollIntervalMs ?? 1000;
    let last = "";
    for (;;) {
      const sandbox = await this.fetchSandbox(id);
      last = (sandbox.state ?? "").toLowerCase();
      if (targets.includes(last)) return sandbox;
      if (FAILED_STATES.has(last)) {
        throw new Error(`Daytona sandbox ${id} failed to ${action} (state ${last}${sandbox.errorReason ? `: ${sandbox.errorReason}` : ""})`);
      }
      if (Date.now() + interval > deadline) {
        throw new Error(`Daytona sandbox ${id} did not ${action} within ${Math.round(timeoutMs / 1000)}s (last state ${last || "unknown"})`);
      }
      await sleep(interval);
    }
  }

  private api<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, `${this.apiUrl}${path}`, body);
  }

  private request<T = unknown>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetch, "Daytona", {
      method,
      url,
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body,
    });
  }
}

const enc = encodeURIComponent;

export function mapDaytonaState(state: string): SandboxState {
  switch (state.toLowerCase()) {
    case "creating":
    case "starting":
    case "restoring":
    case "resuming":
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
    case "pausing":
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
