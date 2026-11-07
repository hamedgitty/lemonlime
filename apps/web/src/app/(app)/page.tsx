import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { NewThreadForm } from "./new-thread-form.tsx";

/** Home is the composer: describe the work, pick the repository and where it runs, send. */
export default async function HomePage() {
  const ctx = await getAppContext();
  await requirePageUser(ctx, "/");
  return (
    <main className="mx-auto w-full max-w-[740px] px-5 pt-[14vh] pb-16">
      <h1 className="mb-6 text-center text-[30px] font-semibold tracking-[-0.03em]">What should your agent work on?</h1>
      <NewThreadForm />
    </main>
  );
}
