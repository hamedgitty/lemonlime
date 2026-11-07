"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client.ts";

const RESULT: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "GitHub is connected. New cloud threads on those repositories can clone, push and open pull requests.", ok: true },
  denied: { text: "GitHub didn't confirm you can manage that installation, so it wasn't connected.", ok: false },
  taken: { text: "That GitHub installation is already connected to another workspace.", ok: false },
  expired: { text: "That link expired or was started by someone else. Try connecting again.", ok: false },
  missing: { text: "GitHub didn't send everything back. Try connecting again.", ok: false },
};

export function GitHubSection({ enabled, initial, result }: { enabled: boolean; initial: { id: string; accountLogin: string }[]; result: string | null }) {
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const message = result ? RESULT[result] : undefined;

  async function disconnect(id: string, login: string) {
    if (
      !window.confirm(
        `Disconnect ${login}? New cloud threads won't be able to push there. To remove the app from GitHub too, uninstall it in your GitHub settings.`,
      )
    )
      return;
    const res = await apiFetch(`/api/github/installations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return setError(res.message);
    setList(l => l.filter(i => i.id !== id));
  }

  if (!enabled) {
    return (
      <p className="mt-4 text-sm text-muted">GitHub isn&apos;t set up on this server yet. Whoever runs it can add a GitHub App (see the self-hosting guide).</p>
    );
  }
  return (
    <div className="mt-5 space-y-4">
      {message && (
        <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${message.ok ? "border-lime bg-lime/15" : "border-red-200 bg-red-50 text-red-800"}`}>
          {message.text}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {list.map(i => (
            <li key={i.id} className="flex items-center gap-4 px-4 py-3">
              <p className="min-w-0 flex-1 truncate font-medium">{i.accountLogin}</p>
              <button type="button" className="btn-danger h-8" onClick={() => disconnect(i.id, i.accountLogin)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      <a href="/api/github/install" className="btn-primary inline-flex h-10 items-center">
        {list.length ? "Add repositories" : "Connect GitHub"}
      </a>
    </div>
  );
}
