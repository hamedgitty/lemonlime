"use client";

import { useEffect } from "react";

/**
 * Sends a signed-out visitor to /login and brings them back to the page they asked for.
 * Layouts can't see the current path on the server (and middleware isn't available on
 * Workers), so the browser supplies it. The login page re-checks the path, so it can
 * never send anyone off-site.
 */
export function SignInRedirect() {
  useEffect(() => {
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`);
  }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center text-sm text-muted">
      <p>
        Taking you to sign in… <a href="/login" className="underline">Continue</a>
      </p>
    </main>
  );
}
