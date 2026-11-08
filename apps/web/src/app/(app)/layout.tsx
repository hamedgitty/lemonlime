import { pageWorkspace } from "@/lib/current-workspace.ts";
import Link from "next/link";
import type { ReactNode } from "react";
import { renderSlot } from "@lemonlime/plugins";
import { Logo } from "@/components/logo.tsx";
import { getUser } from "@/lib/auth.ts";
import { SignInRedirect } from "@/components/sign-in-redirect.tsx";
import { getAppContext } from "@/lib/env.ts";
import { UsageBanner } from "@/components/usage-banner.tsx";
import { usageNotice } from "@/lib/usage.ts";
import { SidebarThreads } from "@/components/sidebar-threads.tsx";
import { listThreads } from "@/lib/threads.ts";
import { listWorkspaces } from "@/lib/members.ts";
import { WorkspaceSwitcher } from "@/components/workspace-switcher.tsx";
import { ComputerThreadList } from "@/components/computer-threads.tsx";
import { listComputerThreads } from "@/lib/computers.ts";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAppContext();
  // Signed out: render nothing from the app. The page's own check (or this fallback,
  // which knows the real address) sends them to /login?next=<this page>.
  const user = await getUser(ctx);
  if (!user) return <SignInRedirect />;
  const workspaceId = await pageWorkspace(ctx.db, user.userId);
  const notice = await usageNotice(ctx, user.userId, workspaceId);
  const { billingUI } = ctx.plugin;

  const threads = await listThreads(ctx, user.userId, workspaceId);
  const workspaceList = await listWorkspaces(ctx.db, user.userId);
  const computers = await listComputerThreads(ctx, user.userId, workspaceId);

  return (
    <div className="flex h-dvh overflow-hidden">
      <nav aria-label="LemonLime" className="hidden w-[288px] shrink-0 flex-col border-r border-line bg-cream-deep md:flex">
        <div className="flex h-14 items-center px-4">
          <Link href="/" aria-label="LemonLime home">
            <Logo />
          </Link>
        </div>
        {workspaceList.length > 1 && <WorkspaceSwitcher workspaces={workspaceList} current={workspaceId} />}
        <div className="px-2">
          <Link href="/" className="flex h-[30px] items-center gap-2.5 rounded-lg px-2 text-sm hover:bg-cream-hover">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 text-muted">
              <path
                d="M7.5 2.5h-4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-4M11.5 2l2.5 2.5-6 6H5.5V8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            New thread
          </Link>
          <Link href="/automations" className="flex h-[30px] items-center gap-2.5 rounded-lg px-2 text-sm hover:bg-cream-hover">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 text-muted">
              <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 4.75V8l2.25 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Automations
          </Link>
        </div>
        <div className="mx-3 my-4 h-px bg-line" />
        <ComputerThreadList computers={computers} variant="sidebar" />
        <p className="px-4 pb-2 text-[13.5px] text-muted">Threads</p>
        <SidebarThreads threads={threads} />
        <div className="px-2 pb-2">{renderSlot(billingUI.headerBadge, { workspaceId })}</div>
        <div className="flex h-11 shrink-0 items-center gap-1 border-t border-line px-2">
          <Link href="/settings" className="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-muted hover:bg-cream-hover hover:text-ink">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            Settings
          </Link>
          <span className="min-w-0 flex-1 truncate px-1 text-right text-[12.5px] text-muted" title={user.email ?? undefined}>
            {user.email}
          </span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="inline-flex h-8 items-center rounded-lg px-2 text-[12.5px] text-muted hover:bg-cream-hover hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 md:hidden">
          <Link href="/" aria-label="LemonLime home">
            <Logo />
          </Link>
          <span className="flex-1" />
          <Link href="/settings" className="text-sm text-muted hover:text-ink">
            Settings
          </Link>
        </header>
        <UsageBanner notice={notice} />
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}
