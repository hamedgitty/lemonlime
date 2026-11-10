"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api-client.ts";
import { timeAgo } from "@/components/status-pill.tsx";

export interface AccessTokenInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `idleDays` is how long a token may go unused before it stops working. */
export function TokensManager({ initial, idleDays }: { initial: AccessTokenInfo[]; idleDays: number }) {
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ token: string; accessToken: AccessTokenInfo }>("/api/tokens", {
      method: "POST",
      body: { name: name.trim() },
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setTokens(t => [res.data.accessToken, ...t]);
    setCreated({ name: res.data.accessToken.name, token: res.data.token });
    setCopied(false);
    setName("");
  }

  async function revoke(token: AccessTokenInfo) {
    if (!window.confirm(`Revoke "${token.name}"? Apps using it will stop working.`)) return;
    setError(null);
    const res = await apiFetch(`/api/tokens/${token.id}`, { method: "DELETE" });
    if (!res.ok) return setError(res.message);
    setTokens(t => t.filter(x => x.id !== token.id));
  }

  async function copy() {
    if (!created) return;
    await navigator.clipboard.writeText(created.token);
    setCopied(true);
  }

  const now = Date.now();

  return (
    <div className="mt-5 space-y-5">
      {created && (
        <div className="rounded-xl border border-lime bg-lime/15 p-4" role="status">
          <p className="text-sm font-medium">Token "{created.name}" created. Copy it now: it will not be shown again.</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[0.8125rem]">{created.token}</code>
            <button type="button" className="btn-primary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button type="button" className="mt-3 text-sm text-muted hover:text-ink" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}

      <form onSubmit={create} className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="token-name" className="label">
            New token name
          </label>
          <input id="token-name" required maxLength={100} className="field" placeholder="Work laptop" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary h-10" disabled={busy || !name.trim()}>
          {busy ? "Creating..." : "Create token"}
        </button>
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-muted">No tokens yet.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">A token expires after {idleDays} days without use.</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {tokens.map(t => (
              <li key={t.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="text-sm text-muted">
                    Created {timeAgo(t.createdAt, now)}, {t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt, now)}` : "never used"}
                  </p>
                </div>
                <button type="button" className="btn-danger h-8" onClick={() => revoke(t)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
