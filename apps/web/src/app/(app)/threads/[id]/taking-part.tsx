"use client";

import { useEffect, useState, type RefObject } from "react";
import type { ThreadEvent, ThreadHistoryResponse } from "@lemonlime/protocol";
import { apiFetch } from "@/lib/api-client.ts";
import type { ThreadResponse } from "@/lib/threads.ts";
import { addEvent } from "@/lib/timeline.ts";

/**
 * How often someone reading along asks for what has been saved since. The runner hands
 * the conversation over every half minute and whenever the agent starts or stops.
 */
const SAVED_HISTORY_EVERY_MS = 20_000;

/**
 * For someone reading a thread they can't take part in: they have no live connection, so
 * fetch what has been saved since, every so often while the page is in view. A closed
 * thread gets one last look and is then left alone.
 */
export function useSavedHistory(
  id: string,
  reading: boolean,
  closed: boolean,
  eventsRef: RefObject<ThreadEvent[]>,
  show: (events: ThreadEvent[]) => void,
): void {
  useEffect(() => {
    if (!reading) return;
    let stopped = false;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        for (let page = 0; page < 10 && !stopped; page++) {
          const after = eventsRef.current.at(-1)?.seq ?? 0;
          const res = await apiFetch<ThreadHistoryResponse>(`/api/threads/${id}/events?after=${after}`);
          if (!res.ok || stopped) return;
          for (const event of res.data.events) eventsRef.current = addEvent(eventsRef.current, event);
          if (res.data.events.length) show(eventsRef.current);
          if (!res.data.more || res.data.events.length === 0) break;
        }
        if (closed) clearInterval(timer);
      } finally {
        busy = false;
      }
    }, SAVED_HISTORY_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, reading, closed, eventsRef, show]);
}

/** What someone sees on a thread they can read but not direct. `starter` is null once that person has left the workspace. */
export function ReaderNote({ starter, closed }: { starter: string | null; closed: boolean }) {
  const who = starter
    ? closed
      ? `${starter} started this thread.`
      : `${starter} started this thread, and only they can direct its agent.`
    : "The person who started this thread has left the workspace, so it can only be read.";
  return (
    <p role="note" className="mt-4 text-sm text-muted">
      {who}
      {closed ? "" : " You're reading the saved conversation, which catches up every minute or so while the agent works."}
    </p>
  );
}

/** The starter's switch for letting the rest of the workspace take part in the thread. */
export function ShareSwitch({
  threadId,
  shared,
  onChanged,
  onError,
}: {
  threadId: string;
  shared: boolean;
  onChanged: (data: ThreadResponse) => void;
  onError: (message: string | null) => void;
}) {
  const [saving, setSaving] = useState(false);
  async function change(next: boolean) {
    setSaving(true);
    onError(null);
    const res = await apiFetch<ThreadResponse>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: { shared: next } });
    setSaving(false);
    if (res.ok) onChanged(res.data);
    else onError(res.message);
  }
  return (
    <label className="mt-4 flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-0.5 size-4" checked={shared} disabled={saving} onChange={e => void change(e.target.checked)} />
      <span>
        <span className="font-medium">Let workspace members take part</span>
        <span className="block text-muted">They can message the agent, use its sandbox and act with the agent account you signed in here.</span>
      </span>
    </label>
  );
}
