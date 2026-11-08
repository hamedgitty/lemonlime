import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { pageWorkspace } from "@/lib/current-workspace.ts";
import { listComputerThreads } from "@/lib/computers.ts";
import { ComputerThreadList } from "@/components/computer-threads.tsx";
import { NewThreadForm } from "./new-thread-form.tsx";

/** Home is the composer: describe the work, pick the repository and where it runs, send. */
export default async function HomePage() {
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, "/");
  // On a phone the sidebar is hidden, so threads on your own computers are listed here.
  const computers = await listComputerThreads(ctx, user.userId, await pageWorkspace(ctx.db, user.userId));
  return (
    <main className="mx-auto w-full max-w-[740px] px-5 pt-[14vh] pb-16">
      <h1 className="mb-6 text-center text-[30px] font-semibold tracking-[-0.03em]">What should your agent work on?</h1>
      <NewThreadForm />
      <div className="md:hidden">
        <ComputerThreadList computers={computers} variant="page" />
      </div>
    </main>
  );
}
