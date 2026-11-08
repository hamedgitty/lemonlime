import type { SandboxSize } from "@lemonlime/protocol";
import { defaultFetch, isStatus, requestJson, trimSlash, type FetchLike } from "./http.ts";
import { launchCommand, type CreateSandboxOptions, type RunnerLaunch, type SandboxInfo, type SandboxProvider, type SandboxState } from "./types.ts";

export interface E2BProviderOptions {
  apiKey: string;
  /**
   * E2B sets CPU and memory per template, so each size maps to a template you build
   * with the runner and agent CLIs installed.
   */
  templates: Record<SandboxSize, string>;
  /** Provider-side safety net: E2B kills a sandbox after this long without a refresh. */
  maxLifetimeMs?: number;
  /** E2B API base URL. Defaults to https://api.<domain>. */
  apiUrl?: string;
  /** Domain sandboxes are served on. Defaults to e2b.app. */
  domain?: string;
  /** How long to wait for envd to confirm the runner started. Default 1 minute. */
  commandStartTimeoutMs?: number;
  /** Custom fetch, mainly for tests. */
  fetch?: FetchLike;
}

/** What E2B returns when it creates or resumes a sandbox. */
interface E2BSandbox {
  sandboxID: string;
  domain?: string | null;
  envdVersion: string;
  envdAccessToken?: string;
}

/** The parts of E2B's sandbox detail this provider reads. */
interface E2BSandboxDetail {
  sandboxID: string;
  state: string;
  domain?: string | null;
  metadata?: Record<string, string>;
}

const DEFAULT_DOMAIN = "e2b.app";
/** Port of envd, the agent inside every E2B sandbox that runs processes. */
const ENVD_PORT = 49983;
const RUNNER_PORT_LABEL = "lemonlime.runner-port";

/** Runs each sandbox on E2B. Pause keeps memory and files, so the runner keeps going after resume. */
export class E2BProvider implements SandboxProvider {
  readonly name = "e2b";
  private readonly ports = new Map<string, number>();
  private readonly domain: string;
  private readonly apiUrl: string;
  private readonly fetch: FetchLike;

  constructor(private readonly opts: E2BProviderOptions) {
    this.domain = opts.domain || DEFAULT_DOMAIN;
    this.apiUrl = trimSlash(opts.apiUrl || `https://api.${this.domain}`);
    this.fetch = opts.fetch ?? defaultFetch;
  }

  private get timeoutSeconds(): number {
    return Math.ceil((this.opts.maxLifetimeMs ?? 60 * 60 * 1000) / 1000);
  }

  async create(o: CreateSandboxOptions): Promise<SandboxInfo> {
    const sandbox = await this.api<E2BSandbox>("POST", "/v2/sandboxes", {
      templateID: this.opts.templates[o.size],
      metadata: { "lemonlime.thread": o.threadId, [RUNNER_PORT_LABEL]: String(o.runner.port), ...o.labels },
      envVars: o.runner.env,
      timeout: this.timeoutSeconds,
    });
    const id = sandbox.sandboxID;
    try {
      if (compareVersions(sandbox.envdVersion, "0.1.0") < 0) {
        throw new Error(`E2B template "${this.opts.templates[o.size]}" is too old (envd ${sandbox.envdVersion}); rebuild it`);
      }
      await this.startCommand(sandbox, launchCommand(o.runner), o.runner.env);
    } catch (err) {
      // The caller never learns this id, so clean up rather than leave it running.
      await this.destroy(id).catch(() => undefined);
      throw err;
    }
    this.ports.set(id, o.runner.port);
    return { id, provider: this.name, state: "running", runnerUrl: this.runnerUrl(id, o.runner.port, sandbox.domain) };
  }

  async get(id: string): Promise<SandboxInfo | null> {
    try {
      const info = await this.api<E2BSandboxDetail>("GET", `/sandboxes/${enc(id)}`);
      const port = Number(info.metadata?.[RUNNER_PORT_LABEL]) || this.ports.get(id) || 7420;
      const state = mapE2BState(info.state);
      return {
        id,
        provider: this.name,
        state,
        runnerUrl: state === "running" ? this.runnerUrl(id, port, info.domain) : null,
      };
    } catch {
      return null;
    }
  }

  async pause(id: string): Promise<void> {
    try {
      // An empty body keeps memory, so processes carry on after resume.
      await this.api("POST", `/sandboxes/${enc(id)}/pause`, {});
    } catch (err) {
      // 404: gone; 409: already paused.
      if (!isStatus(err, 404, 409)) throw err;
    }
  }

  async resume(id: string, runner: RunnerLaunch): Promise<SandboxInfo> {
    // Connecting resumes a paused sandbox (or refreshes a running one's timeout).
    // Memory is restored, so the runner is still running.
    const sandbox = await this.api<E2BSandbox>("POST", `/v2/sandboxes/${enc(id)}/connect`, { timeout: this.timeoutSeconds });
    return { id, provider: this.name, state: "running", runnerUrl: this.runnerUrl(id, runner.port, sandbox.domain) };
  }

  async destroy(id: string): Promise<void> {
    try {
      await this.api("DELETE", `/sandboxes/${enc(id)}`);
    } catch (err) {
      if (!isStatus(err, 404)) throw err;
    }
  }

  private runnerUrl(id: string, port: number, domain?: string | null): string {
    return `https://${port}-${id}.${domain || this.domain}`;
  }

  /**
   * Starts `command` through envd's `process.Process/Start` (a Connect server-streaming
   * RPC, JSON codec) and returns once envd reports the process id. Like the SDK's
   * `commands.run(cmd, { background: true })` followed by a disconnect: closing the
   * stream does not stop the process.
   */
  private async startCommand(sandbox: E2BSandbox, command: string, envs: Record<string, string>): Promise<number> {
    const id = sandbox.sandboxID;
    const url = `https://${ENVD_PORT}-${id}.${sandbox.domain || this.domain}/process.Process/Start`;
    const headers: Record<string, string> = {
      "Content-Type": "application/connect+json",
      "Connect-Protocol-Version": "1",
      "Connect-Timeout-Ms": "60000",
      "Keepalive-Ping-Interval": "50",
      "E2b-Sandbox-Id": id,
      "E2b-Sandbox-Port": String(ENVD_PORT),
    };
    if (sandbox.envdAccessToken) headers["X-Access-Token"] = sandbox.envdAccessToken;
    // envd before 0.4.0 needs the user named; later versions default to the template's user.
    if (compareVersions(sandbox.envdVersion, "0.4.0") < 0) headers.Authorization = `Basic ${btoa("user:")}`;

    const message = { process: { cmd: "/bin/bash", args: ["-l", "-c", command], envs }, stdin: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.commandStartTimeoutMs ?? 60_000);
    try {
      const res = await this.fetch(url, { method: "POST", headers, body: envelope(message), signal: controller.signal });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`E2B could not start the runner: envd answered ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
      }
      const reader = res.body.getReader();
      try {
        for await (const frame of readEnvelopes(reader)) {
          if (frame.flags & END_STREAM) {
            const end = frame.json as { error?: { code?: string; message?: string } };
            const why = end.error ? `${end.error.code ?? "error"}: ${end.error.message ?? ""}` : "stream ended";
            throw new Error(`E2B could not start the runner: ${why}`);
          }
          const pid = (frame.json as { event?: { start?: { pid?: number } } }).event?.start?.pid;
          if (pid !== undefined) return pid;
          // Anything else before the start event (e.g. a keepalive) is skipped.
        }
        throw new Error("E2B could not start the runner: stream ended before the process started");
      } finally {
        // Disconnect. envd keeps the process running; only the event stream closes.
        await reader.cancel().catch(() => undefined);
      }
    } catch (err) {
      if (controller.signal.aborted) throw new Error("E2B could not start the runner: envd did not answer in time");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private api<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.fetch, "E2B", {
      method,
      url: `${this.apiUrl}${path}`,
      headers: { "X-API-Key": this.opts.apiKey },
      body,
    });
  }
}

export function mapE2BState(state: string): SandboxState {
  switch (state.toLowerCase()) {
    case "running":
      return "running";
    case "paused":
    case "pausing":
      return "paused";
    default:
      return "unknown";
  }
}

const enc = encodeURIComponent;

/** Connect envelope flag marking the final message of a stream. */
const END_STREAM = 0b10;

/** Wraps one JSON message in a Connect envelope: 1 flag byte, 4-byte big-endian length, payload. */
export function envelope(message: unknown): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

/** Yields each Connect envelope from a response stream as it arrives. */
async function* readEnvelopes(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<{ flags: number; json: unknown }> {
  let buf = new Uint8Array(0);
  for (;;) {
    while (buf.length >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
      if (buf.length < 5 + len) break;
      const flags = buf[0]!;
      const payload = buf.subarray(5, 5 + len);
      buf = buf.slice(5 + len);
      if (flags & 0b1) throw new Error("E2B envd sent a compressed message, which this client does not support");
      yield { flags, json: len ? JSON.parse(new TextDecoder().decode(payload)) : {} };
    }
    const { done, value } = await reader.read();
    if (done) return;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  }
}

/** Compares dotted version strings numerically; unparsable parts count as 0. */
function compareVersions(a: string | undefined, b: string): number {
  const pa = (a ?? "0").split(/[.+-]/).map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
