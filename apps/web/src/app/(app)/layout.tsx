import Link from "next/link";
import type { ReactNode } from "react";
import { renderSlot } from "@lemonlime/plugins";
import { Logo } from "@/components/logo.tsx";
import { resolveWorkspace } from "@/lib/access.ts";
import { getUser } from "@/lib/auth.ts";
import { SignInRedirect } from "@/components/sign-in-redirect.tsx";
import { getAppContext } from "@/lib/env.ts";
import { UsageBanner } from "@/components/usage-banner.tsx";
import { usageNotice } from "@/lib/usage.ts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAppContext();
  // Signed out: render nothing from the app. The page's own check (or this fallback,
  // which knows the real address) sends them to /login?next=<this page>.
  const user = await getUser(ctx);
  if (!user) return <SignInRedirect />;
  const workspaceId = await resolveWorkspace(ctx.db, user.userId);
  const notice = await usageNotice(ctx, user.userId, workspaceId);
  const { billingUI } = ctx.plugin;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-cream/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
          <Link href="/" aria-label="LemonLime home">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-md px-2.5 py-1.5 text-muted hover:bg-paper hover:text-ink">
              Threads
            </Link>
            <Link href="/settings" className="rounded-md px-2.5 py-1.5 text-muted hover:bg-paper hover:text-ink">
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {renderSlot(billingUI.headerBadge, { workspaceId })}
            {user.email && <span className="hidden text-sm text-muted sm:inline">{user.email}</span>}
            <form action="/auth/signout" method="post">
              <button type="submit" className="btn-ghost h-8 px-3">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <UsageBanner notice={notice} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
