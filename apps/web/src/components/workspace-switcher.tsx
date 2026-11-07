"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client.ts";

export interface WorkspaceOption {
  id: string;
  name: string;
  personal: boolean;
}

/** Switch between your workspaces. Only shown to people in more than one. */
export function WorkspaceSwitcher({ workspaces, current }: { workspaces: WorkspaceOption[]; current: string }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);

  async function choose(id: string) {
    setValue(id);
    setBusy(true);
    const res = await apiFetch("/api/workspaces/current", { method: "POST", body: { workspaceId: id } });
    if (!res.ok) {
      setBusy(false);
      setValue(current);
      return window.alert(res.message);
    }
    // Threads, settings and billing all belong to the workspace: start from the top.
    window.location.assign("/");
  }

  return (
    <div className="px-2 pb-2">
      <label htmlFor="workspace-switcher" className="sr-only">
        Workspace
      </label>
      <select id="workspace-switcher" className="field h-9 text-sm" value={value} disabled={busy} onChange={e => choose(e.target.value)}>
        {workspaces.map(w => (
          <option key={w.id} value={w.id}>
            {w.personal ? `${w.name} (personal)` : w.name}
          </option>
        ))}
      </select>
    </div>
  );
}
