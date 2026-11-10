"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api-client.ts";
import { safeActionLink } from "@/lib/links.ts";
import { timeAgo } from "@/components/status-pill.tsx";

export interface MemberRow {
  userId: string;
  email: string | null;
  name: string | null;
  role: "owner" | "member";
  joinedAt: string;
}

export interface InviteRow {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Who is in the workspace. Owners invite people by email and remove them; anyone can
 * leave a workspace that isn't their personal one.
 */
export function MembersManager({
  initialMembers,
  initialInvites,
  me,
  isOwner,
  canLeave,
}: {
  initialMembers: MemberRow[];
  initialInvites: InviteRow[];
  me: string;
  isOwner: boolean;
  canLeave: boolean;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState(initialInvites);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; actionUrl?: string; actionLabel?: string } | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(null);
    const res = await apiFetch<{ invite: InviteRow }>("/api/workspaces/members", { method: "POST", body: { email: email.trim() } });
    setBusy(false);
    if (!res.ok)
      return setError(
        res.denied
          ? { message: res.denied.reason, actionUrl: safeActionLink(res.denied.actionUrl) ?? undefined, actionLabel: res.denied.actionLabel }
          : { message: res.message },
      );
    setInvites(list => [...list.filter(i => i.email !== res.data.invite.email), res.data.invite]);
    setSent(res.data.invite.email);
    setEmail("");
  }

  async function remove(m: MemberRow) {
    const leaving = m.userId === me;
    if (!window.confirm(leaving ? "Leave this workspace? You'll lose access to its threads." : `Remove ${m.email ?? "this person"} from the workspace?`))
      return;
    setError(null);
    const res = await apiFetch(`/api/workspaces/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    if (!res.ok) return setError({ message: res.message });
    if (leaving) return window.location.assign("/");
    setMembers(list => list.filter(x => x.userId !== m.userId));
  }

  async function withdraw(i: InviteRow) {
    setError(null);
    const res = await apiFetch(`/api/workspaces/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" });
    if (!res.ok) return setError({ message: res.message });
    setInvites(list => list.filter(x => x.id !== i.id));
  }

  const now = Date.now();
  return (
    <div className="mt-5 space-y-5">
      {isOwner && (
        <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end" autoComplete="off">
          <div className="min-w-0 flex-1">
            <label htmlFor="invite-email" className="label">
              Invite by email
            </label>
            <input
              id="invite-email"
              type="email"
              required
              maxLength={320}
              className="field"
              placeholder="teammate@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary h-10" disabled={busy || !email.trim()}>
            {busy ? "Sending..." : "Send invitation"}
          </button>
        </form>
      )}
      {sent && (
        <p role="status" className="text-sm text-muted">
          Sent. {sent} has 7 days to accept, signed in with that address.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error.message}
          {error.actionUrl && (
            <>
              {" "}
              <a href={error.actionUrl} className="font-medium underline">
                {error.actionLabel ?? "See plans"}
              </a>
            </>
          )}
        </p>
      )}
      <ul className="divide-y divide-line rounded-xl border border-line">
        {members.map(m => {
          const removable = m.userId === me ? canLeave : isOwner && m.role !== "owner";
          return (
            <li key={m.userId} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.9375rem]">
                  {m.name || m.email || "Unknown"}
                  {m.userId === me && <span className="text-muted"> (you)</span>}
                </p>
                <p className="truncate text-sm text-muted">
                  {m.name && m.email ? `${m.email}, ` : ""}
                  {m.role === "owner" ? "owner" : "member"}, joined {timeAgo(m.joinedAt, now)}
                </p>
              </div>
              {removable && (
                <button type="button" className="btn-danger h-8" onClick={() => remove(m)}>
                  {m.userId === me ? "Leave" : "Remove"}
                </button>
              )}
            </li>
          );
        })}
        {invites.map(i => (
          <li key={i.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.9375rem]">{i.email}</p>
              <p className="text-sm text-muted">Invited {timeAgo(i.createdAt, now)}, not accepted yet</p>
            </div>
            {isOwner && (
              <button type="button" className="btn-danger h-8" onClick={() => withdraw(i)}>
                Withdraw
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
