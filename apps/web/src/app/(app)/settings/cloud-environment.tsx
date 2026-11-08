"use client";

import { useState, type FormEvent } from "react";
import type { WorkspaceSettings, WorkspaceSettingsResponse } from "@lemonlime/protocol";
import { apiFetch } from "@/lib/api-client.ts";
import { timeAgo } from "@/components/status-pill.tsx";

const KB = 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * The workspace's cloud environment: instructions for every turn, a setup script, commit
 * trailers, automatic retry and auto-delete. Members see them; owners change them. Saving
 * applies to sandboxes started afterwards.
 */
export function CloudEnvironment({ initial, canEdit }: { initial: WorkspaceSettings; canEdit: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [setupScript, setSetupScript] = useState(initial.setupScript);
  const [stripCoauthors, setStripCoauthors] = useState(initial.stripCoauthors);
  const [retry, setRetry] = useState(String(initial.retryMaxWaitMinutes));
  const [autoDelete, setAutoDelete] = useState(initial.autoDeleteDays === null ? "" : String(initial.autoDeleteDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const retryMinutes = Number(retry);
  const autoDeleteDays = autoDelete.trim() === "" ? null : Number(autoDelete);
  const problem =
    bytes(instructions) > 32 * KB
      ? "Instructions can be at most 32 KB."
      : bytes(setupScript) > 16 * KB
        ? "The setup script can be at most 16 KB."
        : !Number.isInteger(retryMinutes) || retryMinutes < 0 || retryMinutes > 10_080
          ? "The retry wait is a whole number of minutes, up to a week (10080)."
          : autoDeleteDays !== null && (!Number.isInteger(autoDeleteDays) || autoDeleteDays < 1 || autoDeleteDays > 3650)
            ? "Auto-delete is a whole number of days from 1 to 3650, or empty for never."
            : null;
  const changed =
    instructions !== saved.instructions ||
    setupScript !== saved.setupScript ||
    stripCoauthors !== saved.stripCoauthors ||
    retryMinutes !== saved.retryMaxWaitMinutes ||
    autoDeleteDays !== saved.autoDeleteDays;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (problem || !canEdit) return;
    setBusy(true);
    setError(null);
    setDone(false);
    const res = await apiFetch<WorkspaceSettingsResponse>("/api/workspace/settings", {
      method: "PUT",
      body: { instructions, setupScript, stripCoauthors, retryMaxWaitMinutes: retryMinutes, autoDeleteDays },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setSaved(res.data.settings);
    setDone(true);
  }

  const now = Date.now();
  return (
    <form onSubmit={save} className="mt-5 space-y-5">
      <fieldset disabled={!canEdit || busy} className="space-y-5">
        <div>
          <label htmlFor="cloud-instructions" className="label">
            Instructions
          </label>
          <textarea
            id="cloud-instructions"
            className="field min-h-28 font-mono text-[0.8125rem]"
            placeholder="Use pnpm. Run the tests before you commit."
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            aria-describedby="cloud-instructions-help"
          />
          <p id="cloud-instructions-help" className="mt-1 text-sm text-muted">
            Added to every turn of every agent in this workspace's cloud threads. Up to 32 KB.
          </p>
        </div>

        <div>
          <label htmlFor="cloud-setup" className="label">
            Setup script
          </label>
          <textarea
            id="cloud-setup"
            className="field min-h-24 font-mono text-[0.8125rem]"
            placeholder={"apt-get install -y ripgrep\nnpm install -g pnpm"}
            spellCheck={false}
            value={setupScript}
            onChange={e => setSetupScript(e.target.value)}
            aria-describedby="cloud-setup-help"
          />
          <p id="cloud-setup-help" className="mt-1 text-sm text-muted">
            A shell script run once in each new sandbox, before the agent starts and before the repository is cloned. What it prints shows up in the thread. Up
            to 16 KB.
          </p>
        </div>

        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={stripCoauthors} onChange={e => setStripCoauthors(e.target.checked)} />
          <span>
            <span className="font-medium">Remove co-author lines from commits</span>
            <span className="block text-muted">Takes &ldquo;Co-authored-by:&rdquo; trailers out of the commits agents make.</span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="cloud-retry" className="label">
              Retry busy turns for up to (minutes)
            </label>
            <input
              id="cloud-retry"
              type="number"
              min={0}
              max={10_080}
              step={1}
              className="field"
              value={retry}
              onChange={e => setRetry(e.target.value)}
              aria-describedby="cloud-retry-help"
            />
            <p id="cloud-retry-help" className="mt-1 text-sm text-muted">
              When the AI provider is overloaded or a usage limit is hit, the turn runs again later. 0 turns it off.
            </p>
          </div>
          <div>
            <label htmlFor="cloud-autodelete" className="label">
              Delete idle threads after (days)
            </label>
            <input
              id="cloud-autodelete"
              type="number"
              min={1}
              max={3650}
              step={1}
              className="field"
              placeholder="Never"
              value={autoDelete}
              onChange={e => setAutoDelete(e.target.value)}
              aria-describedby="cloud-autodelete-help"
            />
            <p id="cloud-autodelete-help" className="mt-1 text-sm text-muted">
              Cloud threads with no activity this long are closed and their sandboxes deleted. Their history stays. Empty means never.
            </p>
          </div>
        </div>
      </fieldset>

      {saved.skills.length > 0 && (
        <div>
          <p className="label">Skills</p>
          <p className="text-sm text-muted">Synced from the desktop app and copied into every new sandbox: {saved.skills.map(s => s.name).join(", ")}.</p>
        </div>
      )}

      {problem && <p className="text-sm text-red-800">{problem}</p>}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {done && !changed && (
        <p role="status" className="text-sm text-muted">
          Saved. New cloud threads use these settings; sandboxes already running keep what they started with.
        </p>
      )}

      <div className="flex items-center gap-4">
        {canEdit ? (
          <button type="submit" className="btn-primary h-10" disabled={busy || !changed || Boolean(problem)}>
            {busy ? "Saving..." : "Save"}
          </button>
        ) : (
          <p className="text-sm text-muted">Only owners can change these.</p>
        )}
        {saved.updatedAt && <p className="text-sm text-muted">Last changed {timeAgo(saved.updatedAt, now)}</p>}
      </div>
    </form>
  );
}
