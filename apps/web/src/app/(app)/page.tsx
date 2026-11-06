import Link from "next/link";
import { AGENT_LABELS, StatusPill, repoName, timeAgo } from "@/components/status-pill.tsx";
import { resolveWorkspace } from "@/lib/access.ts";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { listThreads } from "@/lib/threads.ts";
import { NewThreadForm } from "./new-thread-form.tsx";

export default async function HomePage() {
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, "/");
  const workspaceId = await resolveWorkspace(ctx.db, user.userId);
  const threads = await listThreads(ctx, user.userId, workspaceId);
  const now = Date.now();

  return (
    <main className="mx-auto grid max-w-6xl gap-10 px-5 py-10 lg:grid-cols-[1fr_380px]">
      <section aria-labelledby="threads-heading">
        <div className="flex items-baseline justify-between">
          <h1 id="threads-heading" className="text-3xl font-semibold">Threads</h1>
          <span className="text-sm text-muted">{threads.length === 1 ? "1 thread" : `${threads.length} threads`}</span>
        </div>

        {threads.length === 0 ? (
          <div className="card mt-6 px-6 py-12 text-center">
            <h2 className="text-xl font-semibold">No threads yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
              Start one with the form. Each thread is one conversation with one agent, working on its own branch.
            </p>
          </div>
        ) : (
          <ul className="card mt-6 divide-y divide-line overflow-hidden">
            {threads.map(t => (
              <li key={t.id}>
                <Link href={`/threads/${t.id}`} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-cream/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{t.title || "Untitled thread"}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                      <span>{AGENT_LABELS[t.agent.kind] ?? t.agent.kind}</span>
                      <span aria-hidden>·</span>
                      <span className="truncate">{repoName(t.repo.url)}</span>
                      <span aria-hidden>·</span>
                      <span className="font-mono text-[0.8125rem]">{t.branch}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <StatusPill status={t.status} />
                    <span className="text-xs text-muted">
                      {t.mode === "cloud" ? "Cloud" : "This computer"} · {timeAgo(t.updatedAt, now)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside aria-labelledby="new-thread-heading">
        <div className="card p-5 lg:sticky lg:top-20">
          <h2 id="new-thread-heading" className="text-xl font-semibold">New thread</h2>
          <p className="mt-1 text-sm text-muted">Pick an agent and a repository. It works on a new branch.</p>
          <NewThreadForm />
        </div>
      </aside>
    </main>
  );
}
