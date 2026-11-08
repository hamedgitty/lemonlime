import type { PermissionMode } from "@lemonlime/protocol";

/**
 * What a thread started from Home takes with its first message, beyond the text: files
 * attached before the thread existed, and the permission mode to start in (Plan first, or
 * the access picked under the composer). Held here, in memory, until the thread's runner is
 * up; then the mode is set, the files are uploaded and the message goes with them.
 */
export interface FirstMessage {
  files: File[];
  permission?: PermissionMode;
  /** The message itself, when it isn't kept elsewhere (a local thread keeps its own). */
  text?: string;
  /** Being handed over now, so a reconnect doesn't send it twice. */
  delivering?: boolean;
}

const queued = new Map<string, FirstMessage>();

export function queueFirstMessage(threadId: string, m: FirstMessage): void {
  if (!m.files.length && !m.permission && !m.text) return;
  queued.set(threadId, { ...m, files: [...m.files] });
}

export function peekFirstMessage(threadId: string): FirstMessage | undefined {
  return queued.get(threadId);
}

export function forgetFirstMessage(threadId: string): void {
  queued.delete(threadId);
}

export interface DeliverIo {
  /** Resolves once the connection is live, so the mode reaches the runner before the message. */
  ready: () => Promise<void>;
  /** Start the thread in this mode, before its first turn. */
  setPermission: (mode: PermissionMode) => void;
  /** Upload one file under `id` (resolves once the runner has all of it). */
  upload: (file: File, id: string) => Promise<void>;
  send: (text: string, attachmentIds: string[]) => void;
  newId: () => string;
}

/**
 * Hand a queued first message to a runner that's now up: every file, then (once connected)
 * the mode, then the message with the files that made it. Files that fail are named in `failed`; the
 * message still goes, so the thread starts either way.
 */
export async function deliverFirstMessage(
  m: FirstMessage,
  text: string,
  io: DeliverIo,
): Promise<{ sent: string[]; failed: { name: string; error: string }[] }> {
  const sent: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const file of m.files) {
    const id = io.newId();
    try {
      await io.upload(file, id);
      sent.push(id);
    } catch (err) {
      failed.push({ name: file.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await io.ready();
  if (m.permission) io.setPermission(m.permission);
  if (text.trim()) io.send(text, sent);
  return { sent, failed };
}
