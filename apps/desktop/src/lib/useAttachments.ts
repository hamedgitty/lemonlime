import { useCallback, useEffect, useRef, useState } from "react";
import { runnerHttpBase, uploadAttachment } from "@lemonlime/client";
import type { Connection } from "./useThreadSession.ts";
import { shrinkImage } from "./imageShrink.ts";

const MB = 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

export interface Attachment {
  id: string;
  name: string;
  size: number;
  sent: number;
  state: "uploading" | "done" | "failed";
  error?: string;
}

/** A new upload id, as the runner expects them. */
export const newAttachmentId = () => `up-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** Why a file can't be attached (too big), or null. */
export function attachmentProblem(file: { name: string; size: number }): string | null {
  const image = IMAGE.test(file.name);
  const limit = image ? 10 * MB : 100 * MB;
  return file.size > limit ? `${image ? "Images" : "Files"} can be up to ${limit / MB} MB.` : null;
}

/** Files picked for the next message, uploaded to the thread's runner as soon as they're added. */
export function useAttachments(connection: Connection | null) {
  const [items, setItems] = useState<Attachment[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  useEffect(() => () => aborts.current.forEach(a => a.abort()), []);

  const update = (id: string, patch: Partial<Attachment>) => setItems(list => list.map(a => (a.id === id ? { ...a, ...patch } : a)));

  const add = useCallback(
    (files: File[]) => {
      for (const picked of files) {
        const id = newAttachmentId();
        const base: Attachment = { id, name: picked.name || "pasted-image.png", size: picked.size, sent: 0, state: "uploading" };
        if (!connection) {
          setItems(l => [...l, { ...base, state: "failed", error: "Attach files once the thread is running." }]);
          continue;
        }
        setItems(l => [...l, base]);
        const abort = new AbortController();
        aborts.current.set(id, abort);
        // Big images are made smaller first; the size limit applies to what's sent.
        void shrinkImage(new File([picked], base.name, { type: picked.type, lastModified: picked.lastModified }))
          .catch(() => picked)
          .then(file => {
            if (abort.signal.aborted) return;
            const name = file.name || base.name;
            const problem = attachmentProblem({ name, size: file.size });
            if (problem) {
              aborts.current.delete(id);
              return update(id, { name, size: file.size, state: "failed", error: problem });
            }
            update(id, { name, size: file.size });
            const named = Object.assign(file.slice(0, file.size, file.type), { name });
            return uploadAttachment({
              base: runnerHttpBase(connection.url),
              token: connection.token,
              file: named,
              id,
              signal: abort.signal,
              onProgress: sent => update(id, { sent }),
            }).then(() => update(id, { state: "done", sent: file.size }));
          })
          .catch(err => !abort.signal.aborted && update(id, { state: "failed", error: err instanceof Error ? err.message : String(err) }))
          .finally(() => aborts.current.delete(id));
      }
    },
    [connection],
  );

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    setItems(l => l.filter(a => a.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, add, remove, clear, uploading: items.some(a => a.state === "uploading"), ready: items.filter(a => a.state === "done").map(a => a.id) };
}
