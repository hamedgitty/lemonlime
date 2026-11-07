import { runnerHttpBase, uploadAttachment } from "./attachments.ts";

export interface RunnerAddress {
  /** The runner's thread WebSocket URL (…/ws). */
  url: string;
  token: () => Promise<string>;
}

export interface TeleportProgress {
  step: "packing" | "copying" | "unpacking";
  done: number;
  total: number;
}

/**
 * Move a thread from one runner to another (this computer ⇄ the cloud): pack it there,
 * copy its commits and history here, and unpack, checked against a checksum. Safe to
 * call again after a failure: uploads resume and the import happens once.
 */
export async function teleportThread(o: {
  from: RunnerAddress;
  to: RunnerAddress;
  fromLabel: "cloud" | "computer";
  onProgress?: (p: TeleportProgress) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ already: boolean }> {
  const f = o.fetchImpl ?? fetch;
  const src = runnerHttpBase(o.from.url);
  const dst = runnerHttpBase(o.to.url);
  const auth = async (a: RunnerAddress) => ({ authorization: `Bearer ${await a.token()}` });
  const fail = async (res: Response) => ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;

  o.onProgress?.({ step: "packing", done: 0, total: 1 });
  const exp = await f(`${src}/teleport/export`, { method: "POST", headers: await auth(o.from) });
  if (!exp.ok) throw new Error(await fail(exp));
  const meta = (await exp.json()) as { transferId: string; bundleBytes: number; historyBytes: number; checksum: string };

  const download = async (name: "bundle" | "history.json", size: number): Promise<Blob> => {
    const parts: ArrayBuffer[] = [];
    let got = 0;
    while (got < size) {
      const res = await f(`${src}/teleport/${meta.transferId}/${name}?offset=${got}`, { headers: await auth(o.from) });
      if (!res.ok) throw new Error(await fail(res));
      const buf = await res.arrayBuffer();
      if (!buf.byteLength) throw new Error("The copy stopped short.");
      parts.push(buf);
      got += buf.byteLength;
      o.onProgress?.({ step: "copying", done: got, total: meta.bundleBytes + meta.historyBytes });
    }
    return new Blob(parts);
  };
  const upload = (blob: Blob, name: string, suffix: string) =>
    uploadAttachment({ base: dst, token: o.to.token, file: Object.assign(blob, { name }), id: `tp-${meta.transferId}-${suffix}`, fetchImpl: f });

  const history = await upload(await download("history.json", meta.historyBytes), "history.json", "h");
  const bundle = meta.bundleBytes > 0 ? await upload(await download("bundle", meta.bundleBytes), "thread.bundle", "b") : null;

  o.onProgress?.({ step: "unpacking", done: 0, total: 1 });
  const imp = await f(`${dst}/teleport/import`, {
    method: "POST",
    headers: { ...(await auth(o.to)), "content-type": "application/json" },
    body: JSON.stringify({
      transferId: meta.transferId,
      checksum: meta.checksum,
      historyUpload: history,
      ...(bundle ? { bundleUpload: bundle } : {}),
      from: o.fromLabel,
    }),
  });
  if (!imp.ok) throw new Error(await fail(imp));
  return { already: ((await imp.json()) as { already?: boolean }).already === true };
}
