import type { Metadata } from "next";
import { Logo } from "@/components/logo.tsx";
import { getUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { PairPhone } from "./pair-phone.tsx";

// The address this page is opened with ends in a pairing key. Browsers don't send that part
// to a server; the page also sends no referrer and asks not to be indexed.
export const metadata: Metadata = { title: "Pair this phone", referrer: "no-referrer", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Where a pairing link from the desktop app lands (docs/phone-access.md). It works signed
 * out: the phone is paired first, and signing in comes after.
 */
export default async function PairPhonePage() {
  let signedIn = false;
  try {
    signedIn = (await getUser(await getAppContext())) !== null;
  } catch {
    // Pairing doesn't depend on the session; the page then offers sign-in.
  }
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <Logo />
        <PairPhone signedIn={signedIn} />
      </div>
    </main>
  );
}
