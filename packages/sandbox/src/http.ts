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
  /** Give up after this long without a full answer. Default 2 minutes. */
  timeoutMs?: number;
}

/** A provider that hasn't answered in this long isn't going to; waiting forever would hang the caller. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Sends a JSON request and returns the parsed JSON answer (undefined for an empty body). */
export async function requestJson<T>(fetchFn: FetchLike, provider: string, req: JsonRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
  const init: RequestInit = { method: req.method, headers };
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  const timeoutMs = req.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  init.signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(req.url, init);
    text = await res.text();
  } catch (err) {
    if (!timeout.aborted) throw err;
    throw new Error(`${provider} ${req.method} ${new URL(req.url).pathname} did not answer within ${Math.ceil(timeoutMs / 1000)}s`);
  }
  if (!res.ok) throw new ProviderHttpError(provider, req.method, new URL(req.url).pathname, res.status, errorDetail(text));
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${provider} ${req.method} ${new URL(req.url).pathname} returned a body that is not JSON`);
  }
}

/** The longest piece of a provider's answer that goes into an error message. */
const DETAIL_MAX_CHARS = 200;

/** An id such as a sandbox's: long, but not a credential, and useful in an error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A short, safe piece of a provider's error answer for an error message people will read.
 * Providers sometimes echo the request back, and a request can carry keys and the runner's
 * environment, so anything that looks like a credential is left out: `Bearer` and `Basic`
 * values, values after names such as "token" or "password", strings that start the way
 * common keys do, and long unbroken strings with digits in them (keys, tokens, signatures).
 * What is left is one line, cut to a couple of hundred characters.
 */
export function errorDetail(text: string): string {
  let detail = text;
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const msg = body.message ?? body.error;
    if (typeof msg === "string") detail = msg;
    else if (Array.isArray(msg)) detail = msg.join("; ");
  } catch {
    // not JSON
  }
  const cleaned = detail
    .replace(/\b(bearer|basic)\s+[^\s"',;}]+/gi, "$1 [hidden]")
    .replace(/(secret|token|password|passwd|api[_-]?key|authorization|credential)s?(\\?["']?\s*[:=]\s*\\?["']?)[^\s"',;}\\]+/gi, "$1$2[hidden]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, "[hidden]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, run => (/\d/.test(run) && !UUID.test(run) ? "[hidden]" : run))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > DETAIL_MAX_CHARS ? `${cleaned.slice(0, DETAIL_MAX_CHARS)}…` : cleaned;
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Strips trailing slashes so paths can be appended with a single "/". */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
