"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import type { Thread } from "@lemonlime/protocol";
import { AGENT_LABELS, repoName, timeAgo } from "./status-pill.tsx";

const DOT: Record<string, string> = {
  running: "bg-lemon-2 animate-pulse",
  provisioning: "bg-lemon-2 animate-pulse",
  failed: "bg-red-600",
};

/** The sidebar's thread list: grouped by project, the open thread highlighted, with search. */
export function SidebarThreads({ threads }: { threads: Thread[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? threads.filter(t => `${t.title} ${repoName(t.repo.url)} ${t.branch} ${AGENT_LABELS[t.agent.kind] ?? ""}`.toLowerCase().includes(q))
      : threads;
    const map = new Map<string, Thread[]>();
    for (const t of list) {
      const key = repoName(t.repo.url);
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return [...map.entries()];
  }, [threads, query]);
  const now = Date.now();

  return (
    <>
      <div className="px-2 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 focus-within:border-faint">
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 text-muted">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted">{query ? "No threads match" : "No threads yet"}</p>
        ) : (
          groups.map(([project, list]) => (
            <section key={project} aria-label={project} className="mb-2">
              {groups.length > 1 && <h3 className="truncate px-2 pt-1 pb-0.5 text-[12.5px] font-medium text-muted">{project}</h3>}
              <ul className="flex flex-col gap-px">
                {list.map(t => {
                  const active = pathname === `/threads/${t.id}`;
                  return (
                    <li key={t.id}>
                      <Link
                        href={`/threads/${t.id}`}
                        aria-current={active ? "page" : undefined}
                        className={`flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors ${active ? "bg-cream-hover" : "hover:bg-cream-hover"}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-full ${DOT[t.status] ?? (t.mode === "cloud" ? "bg-lime-2" : "bg-faint")}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{t.title || "Untitled thread"}</span>
                        <span className="shrink-0 text-[12.5px] text-muted tabular-nums">{timeAgo(t.updatedAt, now)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );
}
