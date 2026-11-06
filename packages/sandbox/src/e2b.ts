import { Sandbox } from "e2b";
import type { SandboxSize } from "@lemonlime/protocol";
import type { CreateSandboxOptions, RunnerLaunch, SandboxInfo, SandboxProvider } from "./types.ts";

export interface E2BProviderOptions {
  apiKey: string;
  /**
   * E2B sets CPU and memory per template, so each size maps to a template you build
   * with the runner and agent CLIs installed.
   */
  templates: Record<SandboxSize, string>;
  /** Provider-side safety net: E2B kills a sandbox after this long without a refresh. */
  maxLifetimeMs?: number;
}

/** Runs each sandbox on E2B. Pause keeps memory and files, so the runner keeps going after resume. */
export class E2BProvider implements SandboxProvider {
  readonly name = "e2b";
  private readonly ports = new Map<string, number>();

  constructor(private readonly opts: E2BProviderOptions) {}

  private get conn() {
    return { apiKey: this.opts.apiKey };
  }

  async create(o: CreateSandboxOptions): Promise<SandboxInfo> {
    const sandbox = await Sandbox.create(this.opts.templates[o.size], {
      ...this.conn,
      envs: o.runner.env,
      metadata: { "lemonlime.thread": o.threadId, "lemonlime.runner-port": String(o.runner.port), ...o.labels },
      timeoutMs: this.opts.maxLifetimeMs ?? 60 * 60 * 1000,
    });
    await sandbox.commands.run(o.runner.command, { background: true, envs: o.runner.env });
    this.ports.set(sandbox.sandboxId, o.runner.port);
    return { id: sandbox.sandboxId, provider: this.name, state: "running", runnerUrl: `https://${sandbox.getHost(o.runner.port)}` };
  }

  async get(id: string): Promise<SandboxInfo | null> {
    try {
      const info = await Sandbox.getInfo(id, this.conn);
      const port = Number(info.metadata?.["lemonlime.runner-port"]) || this.ports.get(id) || 7420;
      const running = info.state === "running";
      return {
        id,
        provider: this.name,
        state: running ? "running" : "paused",
        runnerUrl: running ? `https://${port}-${id}.${info.sandboxDomain ?? "e2b.app"}` : null,
      };
    } catch {
      return null;
    }
  }

  async pause(id: string): Promise<void> {
    await Sandbox.pause(id, this.conn).catch(() => undefined);
  }

  async resume(id: string, runner: RunnerLaunch): Promise<SandboxInfo> {
    // connect() resumes a paused sandbox; memory is restored, so the runner is still running.
    const sandbox = await Sandbox.connect(id, { ...this.conn, timeoutMs: this.opts.maxLifetimeMs ?? 60 * 60 * 1000 });
    return { id, provider: this.name, state: "running", runnerUrl: `https://${sandbox.getHost(runner.port)}` };
  }

  async destroy(id: string): Promise<void> {
    await Sandbox.kill(id, this.conn).catch(() => undefined);
  }
}
