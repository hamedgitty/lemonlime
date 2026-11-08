/**
 * The panel browser's own history and recent addresses. A page shown inside the app usually
 * comes from another address, so its own history can't be read; Back and Forward walk the
 * addresses opened here instead (and pages it moved to, when the app can see them).
 */

export interface BrowserHistory {
  entries: string[];
  index: number;
}

/** How many addresses Back can go through. */
export const HISTORY_KEPT = 50;

export const startHistory = (url: string): BrowserHistory => ({ entries: [url], index: 0 });

export const currentAddress = (h: BrowserHistory): string => h.entries[h.index] ?? h.entries[0] ?? "";

/** Go to `url`: anything ahead of the current place is dropped, like any browser. */
export function visit(h: BrowserHistory, url: string): BrowserHistory {
  if (currentAddress(h) === url) return h;
  const entries = [...h.entries.slice(0, h.index + 1), url].slice(-HISTORY_KEPT);
  return { entries, index: entries.length - 1 };
}

export const canGoBack = (h: BrowserHistory) => h.index > 0;
export const canGoForward = (h: BrowserHistory) => h.index < h.entries.length - 1;
export const goBack = (h: BrowserHistory): BrowserHistory => (canGoBack(h) ? { ...h, index: h.index - 1 } : h);
export const goForward = (h: BrowserHistory): BrowserHistory => (canGoForward(h) ? { ...h, index: h.index + 1 } : h);

// ── Recent addresses ────────────────────────────────────────

export const RECENTS_KEPT = 8;
const RECENTS_KEY = "lemonlime:browser-recents";

/** The same page with or without a trailing slash counts once. */
const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** `url` first, each address once, at most `max`. */
export function addRecent(list: readonly string[], url: string, max = RECENTS_KEPT): string[] {
  return [url, ...list.filter(u => !same(u, url))].slice(0, max);
}

export function loadRecentAddresses(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, RECENTS_KEPT) : [];
  } catch {
    return [];
  }
}

export function rememberAddress(url: string): string[] {
  const next = addRecent(loadRecentAddresses(), url);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: recents just aren't kept */
  }
  return next;
}

export function forgetAddresses(): void {
  try {
    localStorage.removeItem(RECENTS_KEY);
  } catch {
    /* nothing to do */
  }
}

/** "localhost:3000/settings" for "http://localhost:3000/settings/": what a person would type. */
export function shortAddress(url: string): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`.replace(/\/+$/, "");
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/** Makes "localhost:3000" or "example.com" into a full address. */
export function normalizeUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v) ? `http://${v}` : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
