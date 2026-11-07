import type { Metadata } from "next";
import { Logo } from "@/components/logo.tsx";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";

export const metadata: Metadata = { title: "Connect the desktop app" };
export const dynamic = "force-dynamic";

const STATE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Step 2 of signing the desktop app in: the app opened this page with a random `state`.
 * Confirming creates a token for that computer and hands it back to the app through its
 * lemonlime:// link, never to any other address.
 */
export default async function ConnectDesktopPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state = "" } = await searchParams;
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, `/desktop/connect?state=${encodeURIComponent(state)}`);
  const valid = STATE.test(state);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-cream px-5">
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-paper p-7 shadow-[0_4px_24px_rgb(23_32_14/0.06)]">
        <Logo />
        {valid ? (
          <>
            <h1 className="mt-6 text-[24px] font-semibold tracking-[-0.02em]">Connect the desktop app?</h1>
            <p className="mt-2 text-sm text-muted">
              The LemonLime app on your computer will be able to start and manage cloud threads as <b className="font-medium text-ink">{user.email}</b>. You can
              revoke it any time in Settings → Personal access tokens.
            </p>
            <form method="post" action="/desktop/connect/approve" className="mt-6 flex gap-2">
              <input type="hidden" name="state" value={state} />
              <button type="submit" className="btn-lemon h-10 flex-1">
                Connect
              </button>
              <a href="/" className="btn-ghost h-10">
                Cancel
              </a>
            </form>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-[24px] font-semibold tracking-[-0.02em]">Start from the app</h1>
            <p className="mt-2 text-sm text-muted">Open LemonLime on your computer, go to Settings → Account, and choose Sign in with your browser.</p>
          </>
        )}
      </div>
    </main>
  );
}
