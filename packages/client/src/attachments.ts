/** Runner WebSocket URL (ws://host:port/ws, or …/sandbox/<name>/ws) → its HTTP base. */
export function runnerHttpBase(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/ws$/, "");
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

export interface UploadOptions {
  /** From runnerHttpBase. */
  base: string;
  token: () => Promise<string>;
  file: Blob & { name: string };
  /** Stable for this file, so a retry resumes rather than starts again. */
  id: string;
  chunkBytes?: number;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Upload a file to the thread's runner in pieces. A dropped piece is retried after asking
 * the runner how much it has, so a flaky connection only costs that piece. Resolves to the
 * upload id to send with the message.
 */
export async function uploadAttachment(o: UploadOptions): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const chunk = o.chunkBytes ?? 4 * 1024 * 1024;
  const call = async (path: string, init: RequestInit = {}) =>
    f(`${o.base}${path}`, {
      ...init,
      ...(o.signal ? { signal: o.signal } : {}),
      headers: { authorization: `Bearer ${await o.token()}`, ...init.headers },
    });
  const failed = async (res: Response) => ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;

  const begin = await call("/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: o.id, name: o.file.name, size: o.file.size }),
  });
  if (!begin.ok) throw new Error(await failed(begin));
  let sent = ((await begin.json()) as { received: number }).received;
  let tries = 0;
  while (sent < o.file.size) {
    o.onProgress?.(sent, o.file.size);
    try {
      const res = await call(`/attachments/${encodeURIComponent(o.id)}?offset=${sent}`, { method: "PUT", body: o.file.slice(sent, sent + chunk) });
      if (res.status === 409) {
        sent = ((await res.json()) as { received: number }).received;
        continue;
      }
      if (!res.ok) throw new Error(await failed(res));
      sent = ((await res.json()) as { received: number }).received;
      tries = 0;
    } catch (err) {
      if (o.signal?.aborted || ++tries > 5) throw err;
      await new Promise(r => setTimeout(r, 500 * 2 ** tries));
      const status = await call(`/attachments/${encodeURIComponent(o.id)}`).catch(() => null);
      if (status?.ok) sent = ((await status.json()) as { received: number }).received;
    }
  }
  o.onProgress?.(o.file.size, o.file.size);
  return o.id;
}

/** A sent image, fetched back from the thread's runner (`GET /attachments/<id>/image`). */
export async function fetchAttachmentImage(o: {
  base: string;
  token: () => Promise<string>;
  id: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Blob> {
  const f = o.fetchImpl ?? fetch;
  const res = await f(`${o.base}/attachments/${encodeURIComponent(o.id)}/image`, {
    headers: { authorization: `Bearer ${await o.token()}` },
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
