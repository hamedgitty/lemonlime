import { useEffect, useRef } from "react";
import type { ThreadStatus } from "@lemonlime/protocol";
import { useThreadSession, type SessionTarget } from "../lib/useThreadSession.ts";

/** How long a thread made without being opened gets to take its first message. */
const GIVE_UP_MS = 10 * 60_000;

/**
 * Starts a thread that was made without being opened: brings its runner up and hands over
 * its first message, the way the thread's own view would. Shows nothing. `onDone` is called
 * once the message has arrived, or with what went wrong; the message then stays with the
 * thread and goes when it is opened.
 */
export function BackgroundStart({
  target,
  onLocalProgress,
  onLocalStatus,
  onLocalPromptSent,
  onCloudRefresh,
  onRunnersChanged,
  onDone,
}: {
  target: SessionTarget;
  onLocalProgress: (id: string, lastSeq: number) => void;
  onLocalStatus: (id: string, status: ThreadStatus) => void;
  onLocalPromptSent: (id: string) => void;
  onCloudRefresh: () => void;
  onRunnersChanged: () => void;
  onDone: (id: string, problem?: string) => void;
}) {
  const local = target.mode === "local";
  const id = target.mode === "local" ? target.meta.id : target.thread.id;
  const session = useThreadSession(target, {
    onProgress: local ? onLocalProgress : undefined,
    onStatus: local ? onLocalStatus : undefined,
    onPromptSent: onLocalPromptSent,
  });
  const done = useRef(onDone);
  done.current = onDone;

  // The runner has the message once it shows in the thread's history.
  const arrived = session.events.some(e => e.type === "user_message");
  const { state, error, restart } = session;
  const cloudStatus = target.mode === "cloud" ? target.thread.status : null;
  useEffect(() => {
    if (arrived) done.current(id);
    else if (state === "error" || (state === "offline" && error)) done.current(id, error ?? "The thread didn't start.");
    else if (state === "offline" && (cloudStatus === "failed" || cloudStatus === "stopped")) done.current(id, "Its sandbox didn't start.");
  }, [arrived, state, error, cloudStatus, id]);

  useEffect(() => {
    const t = setTimeout(() => done.current(id, "It is taking too long to start."), GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [id]);

  // The sidebar shows a runner on this computer as soon as it is up.
  useEffect(() => {
    if (local && state === "connecting") onRunnersChanged();
  }, [local, state, onRunnersChanged]);

  // A cloud sandbox that is still starting has no address yet: look again shortly.
  useEffect(() => {
    if (state !== "offline" || cloudStatus !== "provisioning") return;
    const t = setTimeout(() => {
      onCloudRefresh();
      restart();
    }, 3000);
    return () => clearTimeout(t);
  }, [state, cloudStatus, onCloudRefresh, restart]);

  return null;
}
