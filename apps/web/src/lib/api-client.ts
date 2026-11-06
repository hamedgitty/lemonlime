import { PolicyDenied } from "@lemonlime/protocol";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; denied: PolicyDenied | null };

/** Fetch a control-plane API route from the browser and normalise errors, including 402 policy denials. */
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server. Check your connection.", denied: null };
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: data as T };
  if (res.status === 402) {
    const denied = PolicyDenied.safeParse(data);
    if (denied.success) return { ok: false, status: 402, message: denied.data.reason, denied: denied.data };
  }
  const message =
    data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message
      : `Request failed (${res.status}).`;
  return { ok: false, status: res.status, message, denied: null };
}
