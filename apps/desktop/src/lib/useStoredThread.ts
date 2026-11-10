import { useEffect, useRef, useState } from "react";
import type { Thread, ThreadEvent } from "@lemonlime/protocol";
import type { CloudApi } from "./cloud.ts";
import { loadEvents, saveEvents } from "./storage.ts";
import { readStoredHistory } from "./storedHistory.ts";
import { appendEvents, contiguousSeq } from "./timeline.ts";

/**
 * A cloud thread's conversation as the control plane has kept it, for a thread that is read
 * without reaching its runner. It starts from what this computer has cached and reads on
 * from there whenever the thread's entry in the list says something happened. `loading` is
 * true until the first read is over.
 */
export function useStoredThread(thread: Thread, api: CloudApi): { events: ThreadEvent[]; loading: boolean } {
  const [events, setEvents] = useState<ThreadEvent[]>(() => loadEvents(thread.id));
  const [loading, setLoading] = useState(true);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let stopped = false;
    void readStoredHistory(
      api,
      thread.id,
      contiguousSeq(eventsRef.current),
      page => setEvents(prev => appendEvents(prev, page)),
      () => stopped,
    )
      .catch(() => {
        /* what is cached still shows, and the next change to the thread reads again */
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [api, thread.id, thread.latestSeq, thread.updatedAt, thread.status]);

  // Keep the cache, so the thread opens with its conversation next time.
  useEffect(() => {
    const t = setTimeout(() => saveEvents(thread.id, events), 400);
    return () => clearTimeout(t);
  }, [thread.id, events]);
  useEffect(() => () => saveEvents(thread.id, eventsRef.current), [thread.id]);

  return { events, loading };
}
