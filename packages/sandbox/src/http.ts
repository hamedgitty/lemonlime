/**
 * Tiny fetch helpers shared by the cloud providers. Only `fetch` and other web
 * platform APIs are used, so the providers run on Node 22 and Cloudflare Workers.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Looks `fetch` up on every call instead of capturing it: Workers rejects a
 * detached `fetch`, and tests can swap the global.
 */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** A non-2xx answer from a provider API. */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${provider} ${method} ${path} failed with ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderHttpError";
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof ProviderHttpError && statuses.includes(err.status);
}

export interface JsonRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** Sends a JSON request and returns the parsed JSON answer (undefined for an empty body). */
export async function requestJson<T>(fetchFn: FetchLike, provider: string, req: JsonRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  const init: RequestInit = { method: req.method, headers };
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  if (req.signal) init.signal = req.signal;
  const res = await fetchFn(req.url, init);
  const text = await res.text();
  if (!res.ok) throw new ProviderHttpError(provider, req.method, new URL(req.url).pathname, res.status, errorDetail(text));
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${provider} ${req.method} ${new URL(req.url).pathname} returned a body that is not JSON`);
  }
}

/** Pulls a readable message out of an error body without echoing huge pages. */
function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const msg = body.message ?? body.error;
    if (typeof msg === "string") return msg;
    if (Array.isArray(msg)) return msg.join("; ");
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 300);
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Strips trailing slashes so paths can be appended with a single "/". */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
