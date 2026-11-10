import type { Metadata } from "next";
import { pageWorkspace } from "@/lib/current-workspace.ts";
import { requirePageUser } from "@/lib/auth.ts";
import { listAutomations } from "@/lib/automations.ts";
import { getAppContext } from "@/lib/env.ts";
import { AutomationsManager } from "./automations-manager.tsx";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage() {
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, "/automations");
  const workspaceId = await pageWorkspace(ctx.db, user.userId);
  const list = await listAutomations(ctx, workspaceId, user.userId);
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-5 py-10">
      <div>
        <h1 className="text-3xl font-semibold">Automations</h1>
        <p className="mt-2 text-muted">
          Run a prompt as a new cloud thread on a schedule, or when its webhook is called: a nightly dependency bump, a weekly tidy-up, a morning triage. Each
          run is its own thread, on its own branch, and a run your plan can't cover right then is skipped, not stopped.
        </p>
      </div>
      <AutomationsManager initial={JSON.parse(JSON.stringify(list))} />
    </main>
  );
}
