import type { Metadata } from "next";
import { pageWorkspace } from "@/lib/current-workspace.ts";
import { renderSlot } from "@lemonlime/plugins";
import { listAccessTokens } from "@/lib/access.ts";
import { requirePageUser } from "@/lib/auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { githubAppConfig, listInstallations } from "@/lib/github.ts";
import { listSecrets } from "@/lib/secrets.ts";
import { GitHubSection } from "./github-section.tsx";
import { SecretsManager } from "./secrets-manager.tsx";
import { TokensManager } from "./tokens-manager.tsx";
import { MembersManager } from "./members-manager.tsx";
import { listMembers, listWorkspaces } from "@/lib/members.ts";
import { getWorkspaceSettings } from "@/lib/workspace-settings.ts";
import { CloudEnvironment } from "./cloud-environment.tsx";
import { YourData } from "./your-data.tsx";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const ctx = await getAppContext();
  const user = await requirePageUser(ctx, "/settings");
  const workspaceId = await pageWorkspace(ctx.db, user.userId);
  const { billingUI } = ctx.plugin;
  const tokens = await listAccessTokens(ctx.db, user.userId);
  const secretList = await listSecrets(ctx, workspaceId);
  const githubEnabled = githubAppConfig(ctx.vars) !== null;
  const installations = githubEnabled ? await listInstallations(ctx, workspaceId) : [];
  const githubResult = (await searchParams).github ?? null;
  const controlPlaneUrl = ctx.vars.LEMONLIME_PUBLIC_URL ?? "";
  const { members, invites } = await listMembers(ctx.db, workspaceId);
  const workspace = (await listWorkspaces(ctx.db, user.userId)).find(w => w.id === workspaceId);
  const isOwner = workspace?.role === "owner";
  const cloudSettings = await getWorkspaceSettings(ctx, user.userId, workspaceId);

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
          <dd>
            {workspace?.name ?? "Workspace"} <span className="font-mono text-[0.8125rem] text-muted">{workspaceId}</span>
          </dd>
          {controlPlaneUrl && (
            <>
              <dt className="text-muted">Control plane URL</dt>
              <dd className="font-mono text-[0.8125rem]">{controlPlaneUrl}</dd>
            </>
          )}
        </dl>
      </section>

      {renderSlot(billingUI.accountSection, { workspaceId, isOwner })}

      <section aria-labelledby="members-heading" className="card p-6">
        <h2 id="members-heading" className="text-xl font-semibold">
          Members
        </h2>
        <p className="mt-1 text-sm text-muted">
          Everyone here shares the workspace's threads, automations, secrets and GitHub repositories.{" "}
          {isOwner ? "Invite people by email; they join when they accept, signed in with that address." : "Only owners can invite or remove people."}
        </p>
        <MembersManager initialMembers={members} initialInvites={invites} me={user.userId} isOwner={isOwner} canLeave={!workspace?.personal} />
      </section>

      <section aria-labelledby="github-heading" className="card p-6">
        <h2 id="github-heading" className="text-xl font-semibold">
          GitHub
        </h2>
        <p className="mt-1 text-sm text-muted">
          Install the LemonLime app on the repositories you choose. Cloud threads then clone them, push their branch after every turn, and open pull requests,
          each with a token that only works on that repository and expires within the hour.
        </p>
        <GitHubSection enabled={githubEnabled} initial={installations} result={githubResult} />
      </section>

      <section aria-labelledby="cloud-heading" className="card p-6">
        <h2 id="cloud-heading" className="text-xl font-semibold">
          Cloud environment
        </h2>
        <p className="mt-1 text-sm text-muted">
          How every new cloud sandbox in this workspace starts: instructions for the agent, a setup script, and what happens to busy turns and old threads.
        </p>
        <CloudEnvironment initial={cloudSettings.settings} canEdit={cloudSettings.canEdit} />
      </section>

      <section aria-labelledby="secrets-heading" className="card p-6">
        <h2 id="secrets-heading" className="text-xl font-semibold">
          Secrets
        </h2>
        <p className="mt-1 text-sm text-muted">
          Keys and tokens your agents need in cloud sandboxes, such as NPM_TOKEN. Each one is encrypted, given to new cloud threads as an environment variable,
          and removed from everything the thread records. Never paste secrets into the chat.
        </p>
        <SecretsManager initial={secretList} canEdit={isOwner} />
      </section>

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

      <section aria-labelledby="data-heading" className="card p-6">
        <h2 id="data-heading" className="text-xl font-semibold">
          Your data
        </h2>
        <p className="mt-1 text-sm text-muted">Take a copy of everything kept about you, or delete it.</p>
        <YourData email={user.email} workspace={{ id: workspaceId, name: workspace?.name ?? "Workspace", canDelete: isOwner && !workspace?.personal }} />
      </section>
    </main>
  );
}
