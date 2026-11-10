"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { PolicyDenied } from "@lemonlime/protocol";
import { renderDeniedNotice } from "@/app/actions.ts";
import { safeActionLink } from "@/lib/links.ts";

/** Shows why the usage policy declined: the plugin's notice if it has one, else the reason and its link, when that link is safe to offer. */
export function DeniedNotice({ denied, onDismiss }: { denied: PolicyDenied; onDismiss?: () => void }) {
  const [custom, setCustom] = useState<ReactNode>(null);
  const [loaded, setLoaded] = useState(false);
  const link = safeActionLink(denied.actionUrl);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    renderDeniedNotice(denied)
      .then(node => active && setCustom(node))
      .catch(() => active && setCustom(null))
      .finally(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, [denied]);

  if (loaded && custom) return <div role="alert">{custom}</div>;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-lemon bg-lemon/25 px-4 py-3 text-sm">
      <p className="flex-1 text-ink">{denied.reason}</p>
      {link && (
        <a href={link} className="btn-primary h-8 px-3">
          {denied.actionLabel ?? "Learn more"}
        </a>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-muted hover:text-ink">
          Dismiss
        </button>
      )}
    </div>
  );
}
