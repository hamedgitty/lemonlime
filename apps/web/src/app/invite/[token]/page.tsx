import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo.tsx";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { findInvite, normalizeEmail } from "@/lib/members.ts";
import { AcceptInvite } from "./accept-invite.tsx";

export const metadata: Metadata = { title: "Invitation" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, `/invite/${encodeURIComponent(token)}`);
  const invite = await findInvite(ctx.db, token);
  const wrongAddress = invite.ok && normalizeEmail(user.email ?? "") !== invite.email;

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <Logo />
        {!invite.ok ? (
          <>
            <h1 className="mt-10 text-3xl font-semibold">{invite.reason === "expired" ? "This invitation has expired" : "This invitation can't be used"}</h1>
            <p className="mt-2 text-muted">
              {invite.reason === "expired"
                ? "Invitations work for 7 days. Ask whoever invited you to send a new one."
                : invite.reason === "used"
                  ? "It has already been accepted."
                  : "It was withdrawn, or the link is incomplete. Ask whoever invited you to send a new one."}
            </p>
            <Link href="/" className="btn-primary mt-8 inline-flex h-10 items-center">
              Go to your threads
            </Link>
          </>
        ) : (
          <>
            <h1 className="mt-10 text-3xl font-semibold">Join {invite.workspaceName}</h1>
            <p className="mt-2 text-muted">
              {invite.invitedBy ? `${invite.invitedBy} invited you` : "You were invited"} to share coding agent threads in this workspace. Its owners pay for
              its cloud sandbox time.
            </p>
            {wrongAddress ? (
              <p role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                This invitation is for another email address, and you're signed in as {user.email ?? "someone else"}. Sign out, then sign in with the address
                the invitation was sent to.
              </p>
            ) : (
              <AcceptInvite token={token} />
            )}
          </>
        )}
      </div>
    </main>
  );
}
