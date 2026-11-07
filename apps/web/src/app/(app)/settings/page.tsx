import type { Metadata } from "next";
import { renderSlot } from "@lemonlime/plugins";
import { listAccessTokens, resolveWorkspace } from "@/lib/access.ts";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { TokensManager } from "./tokens-manager.tsx";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, "/settings");
  const workspaceId = await resolveWorkspace(ctx.db, user.userId);
  const { billingUI } = ctx.plugin;
  const tokens = await listAccessTokens(ctx.db, user.userId);
  const controlPlaneUrl = ctx.vars.LEMONLIME_PUBLIC_URL ?? "";

  return (
    <main className="mx-auto max-w-3xl space-y-10 px-5 py-10">
      <h1 className="text-3xl font-semibold">Settings</h1>

      <section aria-labelledby="account-heading" className="card p-6">
        <h2 id="account-heading" className="text-xl font-semibold">
          Account
        </h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Email</dt>
          <dd>{user.email ?? "Unknown"}</dd>
          <dt className="text-muted">Workspace</dt>
          <dd className="font-mono text-[0.8125rem]">{workspaceId}</dd>
          {controlPlaneUrl && (
            <>
              <dt className="text-muted">Control plane URL</dt>
              <dd className="font-mono text-[0.8125rem]">{controlPlaneUrl}</dd>
            </>
          )}
        </dl>
      </section>

      {renderSlot(billingUI.accountSection, { workspaceId })}

      <section aria-labelledby="tokens-heading" className="card p-6">
        <h2 id="tokens-heading" className="text-xl font-semibold">
          Personal access tokens
        </h2>
        <p className="mt-1 text-sm text-muted">
          The desktop app uses a token to start and resume cloud threads for you. Paste it into the desktop app together with the control plane URL. Revoke a
          token any time to sign that app out.
        </p>
        <TokensManager initial={tokens} />
      </section>
    </main>
  );
}
