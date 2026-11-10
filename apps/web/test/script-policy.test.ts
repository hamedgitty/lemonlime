import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.ts";
import { config, proxy } from "../src/proxy.ts";

const POLICY = "content-security-policy";
/** Next.js carries what the page should see as a request header back under this prefix. */
const TO_PAGE = "x-middleware-request-";

function view(headers: Record<string, string> = {}) {
  const response = proxy(new NextRequest("https://lemonlime.test/login", { headers }));
  const policy = response.headers.get(POLICY) ?? "";
  return { response, policy, value: /'nonce-([^']+)'/.exec(policy)?.[1] ?? "" };
}

const reaches = (path: string) => unstable_doesMiddlewareMatch({ config, nextConfig, url: `https://lemonlime.test${path}` });

describe("the script policy on pages", () => {
  it("lets only scripts that carry this page view's value run", () => {
    const { policy, value } = view();
    expect(value).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(policy).toContain(`script-src 'self' 'nonce-${value}' 'strict-dynamic'`);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("makes a new value for every page view", () => {
    expect(view().value).not.toBe(view().value);
  });

  it("keeps every rule the other responses get", async () => {
    const everywhere = (await nextConfig.headers!()).flatMap(rule => rule.headers).find(header => header.key.toLowerCase() === POLICY)!.value;
    expect(view().policy.startsWith(`${everywhere}; script-src `)).toBe(true);
  });

  it("tells the page the same value, over anything the browser sent under that name", () => {
    const { response, policy, value } = view({ [POLICY]: "script-src 'nonce-fromclient'", "x-nonce": "fromclient", "next-router-prefetch": "1" });
    expect(response.headers.get(`${TO_PAGE}x-nonce`)).toBe(value);
    expect(response.headers.get(`${TO_PAGE}${POLICY}`)).toBe(policy);
    expect([...response.headers.values()].join("\n")).not.toContain("fromclient");
  });

  it("covers pages, and leaves API routes and static files alone", () => {
    for (const path of ["/", "/login", "/settings", "/threads/abc", "/desktop/connect/approve", "/no-such-page"]) expect(reaches(path), path).toBe(true);
    for (const path of ["/api/health", "/api/threads/abc", "/_next/static/chunks/main.js", "/_next/image", "/favicon.ico"])
      expect(reaches(path), path).toBe(false);
  });
});
