"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComputerThreads } from "@/lib/computers.ts";
import { timeAgo } from "./status-pill.tsx";

/** Most threads listed per computer; the rest are the oldest. */
const SHOWN = 12;

function offlineLabel(c: ComputerThreads["computer"]): string {
  return c.platform === "mac" ? "Your Mac is offline" : "Offline";
}

/**
 * Threads on the user's own computers that have phone access on: live ones open over the
 * phone bridge; while a computer sleeps they show what they were last doing.
 * `variant="sidebar"` for the desktop-width sidebar, `"page"` for the phone's home page.
 */
export function ComputerThreadList({ computers, variant }: { computers: ComputerThreads[]; variant: "sidebar" | "page" }) {
  const pathname = usePathname();
  const now = Date.now();
  if (computers.length === 0) return null;
  const page = variant === "page";
  return (
    <div className={page ? "mt-10 space-y-6" : "px-2 pb-2"}>
      {computers.map(({ computer, threads }) => {
        const list = [...threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, SHOWN);
        return (
          <section key={computer.id} aria-label={computer.name}>
            <h2
              className={
                page ? "mb-2 flex items-baseline gap-2 text-[15px] font-semibold" : "flex items-baseline gap-2 px-2 pt-1 pb-1 text-[13.5px] text-muted"
              }
            >
              <span className="min-w-0 truncate">{computer.name}</span>
              <span className={`shrink-0 text-[12.5px] font-normal ${computer.online ? "text-leaf" : "text-muted"}`}>
                {computer.online ? "Live" : offlineLabel(computer)}
              </span>
            </h2>
            {list.length === 0 ? (
              <p className="px-2 py-1 text-sm text-muted">No threads on this computer yet</p>
            ) : (
              <ul className={page ? "divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper" : "flex flex-col gap-px"}>
                {list.map(t => {
                  const href = `/computers/${computer.id}/${t.id}`;
                  const active = pathname === href;
                  const dot = !computer.online ? "bg-faint/50" : t.status === "running" ? "bg-leaf animate-pulse" : "bg-leaf";
                  return (
                    <li key={t.id}>
                      <Link
                        href={href}
                        aria-current={active ? "page" : undefined}
                        className={
                          page
                            ? "flex min-h-12 items-center gap-3 px-4 py-2 text-[15px] active:bg-cream-hover"
                            : `flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors ${active ? "bg-cream-hover" : "hover:bg-cream-hover"}`
                        }
                      >
                        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
                        <span className="min-w-0 flex-1 truncate">{t.title || "Untitled thread"}</span>
                        <span className="shrink-0 text-[12.5px] text-muted tabular-nums">
                          {computer.online && t.status === "running" ? "Working" : timeAgo(t.updatedAt, now)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
