"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client.ts";

export function AcceptInvite({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await apiFetch<{ workspaceId: string }>("/api/invites/accept", { method: "POST", body: { token } });
    if (!res.ok) {
      setBusy(false);
      return setError(res.denied?.reason ?? res.message);
    }
    window.location.assign("/");
  }

  return (
    <div className="mt-8 space-y-4">
      <button type="button" className="btn-primary h-10 w-full" onClick={accept} disabled={busy}>
        {busy ? "Joining..." : "Accept and join"}
      </button>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
