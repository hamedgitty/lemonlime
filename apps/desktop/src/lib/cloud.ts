import {
  CreateThreadRequest,
  PolicyDenied,
  Thread,
  ThreadHistoryResponse,
  ThreadWithEndpoint,
  type CreateThreadRequest as CreateThreadRequestT,
  type PendingMessage,
} from "@lemonlime/protocol";
import { z } from "zod";
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/** Client for the control plane's thread API, used for cloud threads. */

export interface CloudConfig {
  url: string;
  token: string;
}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set when a plugin on the control plane declined the action (HTTP 402). */
    readonly denial: PolicyDenied | null = null,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

export function isCloudConfigured(cfg: { controlPlaneUrl: string; accessToken: string }): boolean {
  return cfg.controlPlaneUrl.trim() !== "" && cfg.accessToken.trim() !== "";
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Inside the desktop shell, requests go through the HTTP plugin (Rust side), so
 * a self-hosted control plane does not need CORS rules for the app's origin.
 */
const defaultFetch: FetchLike = (input, init) => (isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init));

export class CloudApi {
  private readonly base: string;

  constructor(
    private readonly cfg: CloudConfig,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {
    this.base = normalizeBaseUrl(cfg.url);
  }

  async listThreads(): Promise<Thread[]> {
    const body = await this.request("GET", "/api/threads");
    return parseThreadList(body);
  }

  async getThread(id: string): Promise<ThreadWithEndpoint> {
    return parseWithEndpoint(await this.request("GET", `/api/threads/${encodeURIComponent(id)}`));
  }

  async createThread(req: CreateThreadRequestT): Promise<ThreadWithEndpoint> {
    const body = CreateThreadRequest.parse(req);
    return parseWithEndpoint(await this.request("POST", "/api/threads", body));
  }

  /** The workspace's automations (scheduled prompts that start cloud threads), with recent runs. */
  async listAutomations(): Promise<AutomationInfo[]> {
    const body = (await this.request("GET", "/api/automations")) as { automations?: AutomationInfo[] } | null;
    return Array.isArray(body?.automations) ? body.automations : [];
  }

  async createAutomation(input: Omit<AutomationInfo, "id" | "enabled" | "nextRunAt" | "recentRuns"> & { enabled?: boolean }): Promise<AutomationInfo> {
    return ((await this.request("POST", "/api/automations", input)) as { automation: AutomationInfo }).automation;
  }

  async updateAutomation(id: string, patch: Partial<Pick<AutomationInfo, "enabled" | "schedule" | "timezone" | "prompt" | "name">>): Promise<AutomationInfo> {
    return ((await this.request("PATCH", `/api/automations/${encodeURIComponent(id)}`, patch)) as { automation: AutomationInfo }).automation;
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.request("DELETE", `/api/automations/${encodeURIComponent(id)}`);
  }

  async pauseThread(id: string): Promise<void> {
    await this.request("POST", `/api/threads/${encodeURIComponent(id)}/pause`);
  }

  async resumeThread(id: string): Promise<ThreadWithEndpoint | null> {
    const body = await this.request("POST", `/api/threads/${encodeURIComponent(id)}/resume`);
    const r = ThreadWithEndpoint.safeParse(body);
    return r.success ? r.data : null;
  }

  /** The deployment's usage banner (e.g. running low on cloud hours), or null. */
  async usageNotice(): Promise<{ level: "info" | "warning" | "blocked"; message: string; actionUrl?: string; actionLabel?: string } | null> {
    const body = (await this.request("GET", "/api/usage")) as { notice?: unknown } | null;
    const n = body?.notice as { level?: string; message?: string; actionUrl?: string; actionLabel?: string } | null | undefined;
    if (!n || typeof n.message !== "string" || !["info", "warning", "blocked"].includes(n.level ?? "")) return null;
    return {
      level: n.level as "info" | "warning" | "blocked",
      message: n.message,
      ...(n.actionUrl ? { actionUrl: n.actionUrl } : {}),
      ...(n.actionLabel ? { actionLabel: n.actionLabel } : {}),
    };
  }

  /** The deployment's usage card for the sidebar (e.g. cloud hours left), or null. */
  async usageSummary(): Promise<{ title: string; detail: string; progress?: number; actionUrl?: string; actionLabel?: string } | null> {
    const body = (await this.request("GET", "/api/usage")) as { summary?: unknown } | null;
    const s = body?.summary as { title?: unknown; detail?: unknown; progress?: unknown; actionUrl?: unknown; actionLabel?: unknown } | null | undefined;
    if (!s || typeof s.title !== "string" || typeof s.detail !== "string") return null;
    return {
      title: s.title,
      detail: s.detail,
      ...(typeof s.progress === "number" ? { progress: Math.min(1, Math.max(0, s.progress)) } : {}),
      ...(typeof s.actionUrl === "string" && s.actionUrl.startsWith("https://") ? { actionUrl: s.actionUrl } : {}),
      ...(typeof s.actionLabel === "string" ? { actionLabel: s.actionLabel } : {}),
    };
  }

  /** Stored history after `after`; works while the sandbox is paused, without waking it. */
  async history(id: string, after: number): Promise<ThreadHistoryResponse> {
    const body = await this.request("GET", `/api/threads/${encodeURIComponent(id)}/events?after=${after}`);
    const r = ThreadHistoryResponse.safeParse(body);
    return r.success ? r.data : { events: [], more: false };
  }

  /** Message a paused thread: saved by the control plane first, then the sandbox wakes. */
  async sendWhilePaused(id: string, msg: PendingMessage): Promise<ThreadWithEndpoint | null> {
    const body = await this.request("POST", `/api/threads/${encodeURIComponent(id)}/messages`, msg);
    const r = ThreadWithEndpoint.safeParse(body);
    return r.success ? r.data : null;
  }

  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    if (!this.base) throw new CloudError("Add a control plane URL in Settings first.", 0);
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new CloudError(`Could not reach the control plane: ${err instanceof Error ? err.message : String(err)}`, 0);
    }

    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (res.ok) return json;

    if (res.status === 402) {
      const denial = PolicyDenied.safeParse(json);
      if (denial.success) throw new CloudError(denial.data.reason, 402, denial.data);
    }
    throw new CloudError(errorMessage(res.status, json, text), res.status);
  }
}

function errorMessage(status: number, json: unknown, text: string): string {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    for (const k of ["message", "error", "reason"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  if (status === 401) return "The control plane did not accept your access token.";
  if (status === 403) return "Your access token is not allowed to do that.";
  if (status === 404) return "Not found on the control plane.";
  return text.trim().slice(0, 200) || `The control plane answered with HTTP ${status}.`;
}

/** Accepts `Thread[]`, `{ threads: Thread[] }`, or the same with `ThreadWithEndpoint` items. */
export function parseThreadList(body: unknown): Thread[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { threads?: unknown }).threads)
      ? (body as { threads: unknown[] }).threads
      : null;
  if (!list) throw new CloudError("The control plane sent a thread list this app does not understand.", 200);
  const out: Thread[] = [];
  for (const item of list) {
    const direct = Thread.safeParse(item);
    if (direct.success) {
      out.push(direct.data);
      continue;
    }
    const wrapped = z.object({ thread: Thread }).safeParse(item);
    if (wrapped.success) out.push(wrapped.data.thread);
  }
  return out;
}

function parseWithEndpoint(body: unknown): ThreadWithEndpoint {
  const r = ThreadWithEndpoint.safeParse(body);
  if (r.success) return r.data;
  const t = Thread.safeParse(body);
  if (t.success) return { thread: t.data, endpoint: null };
  throw new CloudError("The control plane sent a thread this app does not understand.", 200);
}

export interface AutomationInfo {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  agent: { kind: "claude-code" | "codex" | "opencode" | "acp"; model?: string; reasoning?: string };
  repo: { url: string; baseBranch: string };
  sandboxSize?: "small" | "large";
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  recentRuns?: { id: string; status: "started" | "skipped" | "failed"; ranAt: string; threadId: string | null; detail: string | null }[];
}
