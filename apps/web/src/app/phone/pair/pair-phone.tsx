"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { acceptPairing, type PairingOutcome } from "./pairing.ts";

const HOW_TO_PAIR = "On your computer, open LemonLime's settings, choose Phone, then Pair a phone.";

const TEXT: Record<PairingOutcome["state"], { title: string; body: string }> = {
  paired: {
    title: "This phone is paired",
    body: "It can now open the threads on your computer. The pairing code is kept in this browser, so use this browser for your dashboard.",
  },
  "not-kept": {
    title: "This browser couldn't keep the pairing code",
    body: "That happens in private browsing, or when the browser is set not to store anything. Scan the code again with your phone's usual browser.",
  },
  malformed: {
    title: "This pairing link doesn't work",
    body: `Part of it is missing or was changed. ${HOW_TO_PAIR} Then scan the code again.`,
  },
  none: {
    title: "Pair this phone with your computer",
    body: `${HOW_TO_PAIR} Scan the code it shows with this phone's camera.`,
  },
};

/**
 * Runs in the browser only: the pairing key is in the address's fragment, which the server
 * never sees. It is kept in this browser and taken out of the address bar at once, and
 * nothing on this page links to or loads anything with it.
 */
export function PairPhone({ signedIn }: { signedIn: boolean }) {
  const [outcome, setOutcome] = useState<PairingOutcome | null>(null);
  const read = useRef(false);

  useEffect(() => {
    // Once: after the first look the fragment is gone.
    if (read.current) return;
    read.current = true;
    const fragment = window.location.hash;
    if (fragment) window.history.replaceState(null, "", window.location.pathname);
    setOutcome(acceptPairing(fragment));
  }, []);

  if (!outcome) {
    return (
      <p className="mt-10 text-muted" aria-live="polite">
        Pairing this phone…
      </p>
    );
  }
  const text = TEXT[outcome.state];
  const failed = outcome.state === "not-kept" || outcome.state === "malformed";
  return (
    <div aria-live="polite">
      <h1 className="mt-10 text-3xl font-semibold">{text.title}</h1>
      <p className="mt-2 text-muted">{text.body}</p>
      {!failed &&
        (signedIn ? (
          <Link href="/" className="btn-primary mt-8 inline-flex h-10 items-center">
            {outcome.state === "paired" ? "See your computer's threads" : "Go to your threads"}
          </Link>
        ) : (
          <>
            {outcome.state === "paired" && <p className="mt-2 text-muted">Sign in to see them.</p>}
            <Link href="/login" className="btn-primary mt-8 inline-flex h-10 items-center">
              Sign in
            </Link>
          </>
        ))}
    </div>
  );
}
