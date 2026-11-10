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

// And a window that can carry the "that link was refused" signal.
(globalThis as unknown as { window: EventTarget }).window = new EventTarget();

const { acceptSignInLink, isWebAddress, onSignInRefused, startBrowserSignIn } = await import("../src/lib/desktopAuth.ts");
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

  it("says so when a sign-in under way gets a link it can't accept, and only then", () => {
    let refusals = 0;
    const stop = onSignInRefused(() => refusals++);
    const good = { token: "t", state: "s".repeat(32), url: "https://app.lemonlime.dev" };
    // Nobody asked to sign in: there is nobody to tell.
    acceptSignInLink(link(good), 1_000_500);
    acceptSignInLink("https://app.lemonlime.dev/auth?token=t", 1_000_500);
    expect(refusals).toBe(0);
    pending();
    acceptSignInLink(link({ ...good, state: "x".repeat(32) }), 1_000_500);
    expect(refusals).toBe(1);
    acceptSignInLink(link({ ...good, url: "https://evil.example" }), 1_000_500);
    expect(refusals).toBe(2);
    acceptSignInLink(link({ ...good, token: "" }), 1_000_500);
    expect(refusals).toBe(3);
    // The right link still signs in afterwards, quietly.
    expect(acceptSignInLink(link(good), 1_000_500)).toEqual({ token: "t", url: "https://app.lemonlime.dev" });
    expect(refusals).toBe(3);
    stop();
    pending();
    acceptSignInLink(link({ ...good, state: "x".repeat(32) }), 1_000_500);
    expect(refusals).toBe(3);
  });

  it("tells a full web address from one a browser can't open", () => {
    expect(isWebAddress("https://app.lemonlime.dev")).toBe(true);
    expect(isWebAddress(" http://localhost:3000 ")).toBe(true);
    expect(isWebAddress("app.lemonlime.dev")).toBe(false);
    expect(isWebAddress("lemonlime://auth")).toBe(false);
    expect(isWebAddress("")).toBe(false);
  });

  it("doesn't start a sign-in for an address a browser can't open", async () => {
    await expect(startBrowserSignIn("app.lemonlime.dev")).rejects.toThrow("full URL");
    expect(store.has(KEY)).toBe(false);
  });
});
