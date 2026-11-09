"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api-client.ts";

interface Preview {
  workspaces: { id: string; name: string; personal: boolean; otherMembers: number; threads: number }[];
  leaves: { id: string; name: string }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Download everything kept about you, delete a team workspace you own, or delete your
 * account. Deleting asks you to type the email (or workspace name) first, and says exactly
 * what goes.
 */
export function YourData({ email, workspace }: { email: string | null; workspace: { id: string; name: string; canDelete: boolean } }) {
  return (
    <div className="mt-5 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          One JSON file with your account, sign-ins, sessions, workspaces, secret names (never their values) and the threads you started, with their full
          conversations.
        </p>
        <a href="/api/account/export" download className="btn-ghost h-9">
          Download your data
        </a>
      </div>
      {workspace.canDelete && <DeleteWorkspace workspace={workspace} />}
      {email && <DeleteAccount email={email} />}
    </div>
  );
}

function DeleteWorkspace({ workspace }: { workspace: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE", body: { confirm: typed } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    window.location.assign("/");
  }

  return (
    <div className="rounded-xl border border-danger/25 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Delete the {workspace.name} workspace</p>
          <p className="text-sm text-muted">Every thread, sandbox, conversation, secret and automation in it is deleted, for everyone in it.</p>
        </div>
        {!open && (
          <button type="button" className="btn-danger h-9" onClick={() => setOpen(true)}>
            Delete workspace
          </button>
        )}
      </div>
      {open && (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <label htmlFor="confirm-workspace" className="label">
            Type <span className="font-mono">{workspace.name}</span> to confirm
          </label>
          <input id="confirm-workspace" className="field" autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-danger h-9" disabled={busy || typed.trim() !== workspace.name}>
              {busy ? "Deleting..." : "Delete it for good"}
            </button>
            <button type="button" className="btn-ghost h-9" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function DeleteAccount({ email }: { email: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    const res = await apiFetch<Preview>("/api/account");
    if (!res.ok) return setError(res.message);
    setPreview(res.data);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiFetch("/api/account", { method: "DELETE", body: { confirm: typed } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    window.location.assign("/login?deleted=1");
  }

  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <div className="rounded-xl border border-danger/25 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Delete your account</p>
          <p className="text-sm text-muted">Your account, sign-ins, tokens and the workspaces only you own are deleted at once. This can&apos;t be undone.</p>
        </div>
        {!preview && (
          <button type="button" className="btn-danger h-9" onClick={start}>
            Delete account
          </button>
        )}
      </div>
      {preview && (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="text-sm">
            <p className="font-medium">This deletes:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {preview.workspaces.map(w => (
                <li key={w.id}>
                  {w.personal ? "Your personal workspace" : `The ${w.name} workspace`}, with {plural(w.threads, "thread")}
                  {w.otherMembers > 0 && <strong className="text-danger"> ({plural(w.otherMembers, "other person", "other people")} lose it too)</strong>}
                </li>
              ))}
              <li>Your sign-ins, sessions, access tokens, linked computers and saved agent sign-ins</li>
            </ul>
            {preview.leaves.length > 0 && (
              <p className="mt-2 text-muted">You leave {preview.leaves.map(w => w.name).join(", ")}. Threads you started there stay with that team.</p>
            )}
            <p className="mt-2 text-muted">
              Records the service must keep by law, such as invoices, may be kept. If you installed the GitHub app, remove it on GitHub too.
            </p>
          </div>
          <label htmlFor="confirm-email" className="label">
            Type <span className="font-mono">{email}</span> to confirm
          </label>
          <input id="confirm-email" className="field" autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-danger h-9" disabled={busy || !matches}>
              {busy ? "Deleting..." : "Delete my account"}
            </button>
            <button type="button" className="btn-ghost h-9" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && !preview && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
