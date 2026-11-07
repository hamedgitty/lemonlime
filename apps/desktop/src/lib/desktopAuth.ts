import { isTauri } from "@tauri-apps/api/core";
import { normalizeBaseUrl } from "./cloud.ts";
import { openExternal } from "../components/ui.tsx";

const PENDING_KEY = "lemonlime:pending-sign-in";
/** Pending browser sign-ins expire after this long. */
const MAX_AGE_MS = 15 * 60_000;

interface Pending {
  state: string;
  url: string;
  at: number;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Open the dashboard's "connect the desktop app" page in the browser. */
export async function startBrowserSignIn(dashboardUrl: string): Promise<void> {
  const url = normalizeBaseUrl(dashboardUrl);
  const pending: Pending = { state: randomState(), url, at: Date.now() };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* without storage the link can't be checked, and will be refused */
  }
  await openExternal(`${url}/desktop/connect?state=${encodeURIComponent(pending.state)}`);
}

/**
 * Check a lemonlime://auth link from the browser. It is accepted only if it answers the
 * sign-in this app started (same random state, same dashboard, not expired), so a web
 * page can't open such a link and point the app somewhere else.
 */
export function acceptSignInLink(link: string, now = Date.now()): { token: string; url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (parsed.protocol !== "lemonlime:" || (parsed.hostname !== "auth" && parsed.pathname.replace(/^\/+/, "") !== "auth")) return null;
  let pending: Pending | null = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as Pending | null;
  } catch {
    pending = null;
  }
  const token = parsed.searchParams.get("token") ?? "";
  const state = parsed.searchParams.get("state") ?? "";
  const url = parsed.searchParams.get("url") ?? "";
  if (!pending || !token || state !== pending.state || now - pending.at > MAX_AGE_MS) return null;
  let sameDashboard = false;
  try {
    sameDashboard = new URL(url).origin === new URL(pending.url).origin;
  } catch {
    sameDashboard = false;
  }
  if (!sameDashboard) return null;
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
  return { token, url: pending.url };
}

/** Listen for lemonlime:// links (also the one that launched the app). */
export async function onSignInLink(handle: (link: string) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const first = await getCurrent().catch(() => null);
  for (const l of first ?? []) handle(l);
  return onOpenUrl(urls => urls.forEach(handle));
}
