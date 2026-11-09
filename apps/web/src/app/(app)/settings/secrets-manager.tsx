"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/api-client.ts";
import { timeAgo } from "@/components/status-pill.tsx";

export interface SecretInfo {
  name: string;
  updatedAt: string;
}

const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * Add, replace and remove workspace secrets. Values are typed once, sent straight to the
 * server to be encrypted, and never shown again, here or anywhere else.
 */
export function SecretsManager({ initial, canEdit }: { initial: SecretInfo[]; canEdit: boolean }) {
  const [list, setList] = useState(initial);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const cleanName = name.trim().toUpperCase();
  const nameProblem = cleanName && !NAME.test(cleanName) ? "Use capital letters, digits and underscores, like NPM_TOKEN." : null;
  const replacing = list.some(s => s.name === cleanName);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (nameProblem) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const res = await apiFetch<{ secret: SecretInfo }>("/api/secrets", { method: "PUT", body: { name: cleanName, value } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setList(l => [...l.filter(s => s.name !== res.data.secret.name), res.data.secret].sort((a, b) => a.name.localeCompare(b.name)));
    setSaved(res.data.secret.name);
    setName("");
    setValue("");
  }

  async function remove(secret: SecretInfo) {
    if (!window.confirm(`Delete ${secret.name}? New cloud threads won't get it. Sandboxes that already have it keep it.`)) return;
    setError(null);
    const res = await apiFetch(`/api/secrets/${encodeURIComponent(secret.name)}`, { method: "DELETE" });
    if (!res.ok) return setError(res.message);
    setList(l => l.filter(s => s.name !== secret.name));
  }

  const now = Date.now();
  return (
    <div className="mt-5 space-y-5">
      {!canEdit && <p className="text-sm text-muted">Only the workspace's owners can add or remove secrets.</p>}
      {canEdit && (
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end" autoComplete="off">
          <div>
            <label htmlFor="secret-name" className="label">
              Name
            </label>
            <input
              id="secret-name"
              required
              maxLength={64}
              className="field font-mono"
              placeholder="NPM_TOKEN"
              spellCheck={false}
              autoCapitalize="characters"
              value={name}
              onChange={e => setName(e.target.value)}
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameProblem ? "secret-name-problem" : undefined}
            />
          </div>
          <div>
            <label htmlFor="secret-value" className="label">
              Value
            </label>
            <input
              id="secret-value"
              required
              type="password"
              className="field font-mono"
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              onChange={e => setValue(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary h-10" disabled={busy || !cleanName || !value || Boolean(nameProblem)}>
            {busy ? "Saving..." : replacing ? "Replace" : "Add secret"}
          </button>
        </form>
      )}
      {nameProblem && (
        <p id="secret-name-problem" className="text-sm text-red-800">
          {nameProblem}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-muted">
          Saved {saved}. New cloud threads get it as an environment variable.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {list.length === 0 ? (
        <p className="text-sm text-muted">No secrets yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {list.map(s => (
            <li key={s.name} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[0.9375rem]">{s.name}</p>
                <p className="text-sm text-muted">Updated {timeAgo(s.updatedAt, now)}</p>
              </div>
              {canEdit && (
                <button type="button" className="btn-danger h-8" onClick={() => remove(s)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
