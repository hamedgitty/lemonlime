"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadPairingKey, sealedWebSocket, type SealRefusal } from "@lemonlime/client";
import type { ComputerSummary } from "@/lib/computers.ts";
import type { ThreadResponse } from "@/lib/threads.ts";
import { ThreadView } from "../../../threads/[id]/thread-view.tsx";
import { phoneMode } from "./phone-mode.ts";

/**
 * A thread on one of your computers, reached the way this browser is allowed to: sealed
 * with the computer's pairing key when it holds one, not at all when the computer wants a
 * paired phone and this isn't one, and openly only for a desktop app from before pairing.
 */
export function PairedThread({ initial, computer }: { initial: ThreadResponse; computer: ComputerSummary }) {
  const threadId = initial.thread.id;
  // The key is in this browser's storage, so it is only known once the page is running here.
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [refused, setRefused] = useState<SealRefusal | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setKey(loadPairingKey(computer.id)), [computer.id]);

  const socket = useMemo(
    () => (key ? sealedWebSocket({ key, computerId: computer.id, threadId, onRefused: setRefused }) : undefined),
    [key, computer.id, threadId],
  );

  /** Look for the key again (the phone may have been paired in another tab) and start over. */
  const tryAgain = useCallback(() => {
    setKey(loadPairingKey(computer.id));
    setRefused(null);
    setAttempt(n => n + 1);
  }, [computer.id]);

  if (key === undefined) return <Frame title={initial.thread.title} />;

  const mode = phoneMode(key !== null, computer.sealed);
  const howToPair = `On ${computer.name}, open LemonLime's settings, choose Phone, then Pair a phone. Scan the code with this phone's camera, or open its link in this browser.`;

  if (mode === "pair-first") {
    return (
      <Frame title={initial.thread.title}>
        <Notice title="Pair this phone with your computer" onTryAgain={tryAgain}>
          Threads on {computer.name} only open on a phone that has been paired with it. {howToPair}
        </Notice>
      </Frame>
    );
  }
  if (mode === "sealed" && refused === "not-paired") {
    return (
      <Frame title={initial.thread.title}>
        <Notice title="Pair this phone with your computer again" onTryAgain={tryAgain}>
          {computer.name} no longer accepts this phone's pairing code. {howToPair}
        </Notice>
      </Frame>
    );
  }
  if (mode === "sealed" && refused === "unprotected") {
    return (
      <Frame title={initial.thread.title}>
        <Notice title="This connection couldn't be protected" onTryAgain={tryAgain}>
          What came back wasn't sealed for this phone by {computer.name}, so nothing was shown and nothing more was sent. Make sure LemonLime on {computer.name}{" "}
          is up to date, then try again.
        </Notice>
      </Frame>
    );
  }
  return (
    <>
      {mode === "unsealed" && <p className="mx-auto max-w-3xl px-5 pt-4 text-sm text-muted">Update LemonLime on {computer.name} to pair this phone with it.</p>}
      <ThreadView key={attempt} initial={initial} computer={computer} socket={socket} />
    </>
  );
}

/** The thread page's outline, for when the thread itself isn't shown. */
function Frame({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-3xl flex-col px-5">
      <header className="border-b border-line py-6">
        <Link href="/" className="text-sm text-muted hover:text-ink">
          Threads
        </Link>
        <h1 className="mt-2 text-2xl font-semibold leading-tight">{title || "Untitled thread"}</h1>
      </header>
      {children}
    </main>
  );
}

function Notice({ title, onTryAgain, children }: { title: string; onTryAgain: () => void; children: ReactNode }) {
  return (
    <section className="card mt-8 p-6" aria-live="polite">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{children}</p>
      <button type="button" className="btn-ghost mt-4" onClick={onTryAgain}>
        Try again
      </button>
    </section>
  );
}
