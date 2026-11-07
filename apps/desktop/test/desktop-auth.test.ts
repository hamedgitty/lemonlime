import { beforeEach, describe, expect, it } from "vitest";

// A tiny sessionStorage for the node test environment.
const store = new Map<string, string>();
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const { acceptSignInLink } = await import("../src/lib/desktopAuth.ts");
const KEY = "lemonlime:pending-sign-in";
const pending = (over: Partial<{ state: string; url: string; at: number }> = {}) =>
  sessionStorage.setItem(KEY, JSON.stringify({ state: "s".repeat(32), url: "https://app.lemonlime.dev", at: 1_000_000, ...over }));
const link = (q: Record<string, string>) => `lemonlime://auth?${new URLSearchParams(q).toString()}`;

describe("browser sign-in links", () => {
  beforeEach(() => store.clear());

  it("accepts the link that answers our own request, once", () => {
    pending();
    const ok = acceptSignInLink(link({ token: "ll_pat_abc", state: "s".repeat(32), url: "https://app.lemonlime.dev" }), 1_000_500);
    expect(ok).toEqual({ token: "ll_pat_abc", url: "https://app.lemonlime.dev" });
    expect(acceptSignInLink(link({ token: "ll_pat_abc", state: "s".repeat(32), url: "https://app.lemonlime.dev" }), 1_000_600)).toBeNull();
  });

  it("refuses links nobody asked for, for another server, with the wrong state, or too late", () => {
    expect(acceptSignInLink(link({ token: "t", state: "s".repeat(32), url: "https://app.lemonlime.dev" }), 1_000_500)).toBeNull();
    pending();
    expect(acceptSignInLink(link({ token: "t", state: "x".repeat(32), url: "https://app.lemonlime.dev" }), 1_000_500)).toBeNull();
    expect(acceptSignInLink(link({ token: "t", state: "s".repeat(32), url: "https://evil.example" }), 1_000_500)).toBeNull();
    expect(acceptSignInLink(link({ token: "t", state: "s".repeat(32), url: "https://app.lemonlime.dev" }), 1_000_000 + 16 * 60_000)).toBeNull();
    expect(acceptSignInLink("https://app.lemonlime.dev/auth?token=t", 1_000_500)).toBeNull();
  });
});
