import { describe, expect, it } from "vitest";
import { isFromAnotherSite, isSignInFromAnotherSite, json, route } from "../src/lib/http.ts";

const TOKEN = `llpat_${"a".repeat(43)}`;

function request(method: string, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/threads", { method, headers });
}

describe("requests from other sites", () => {
  it("are refused when they would change something using the browser's sign-in cookie", async () => {
    let ran = 0;
    const handler = route(async () => {
      ran++;
      return json({ ok: true });
    });
    const res = await handler(request("POST", { cookie: "session=abc", "sec-fetch-site": "cross-site" }), {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", message: "That request came from another site." });
    expect(ran).toBe(0);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isFromAnotherSite(request(method, { cookie: "session=abc", "sec-fetch-site": "cross-site" })), method).toBe(true);
      // Another site under the same domain name counts as another site too.
      expect(isFromAnotherSite(request(method, { cookie: "session=abc", "sec-fetch-site": "same-site" })), method).toBe(true);
    }
  });

  it("are let through when they come from this site, only read, or don't rely on the cookie", async () => {
    const handler = route(async () => json({ ok: true }));
    // The site's own pages, and requests the person made themselves.
    expect((await handler(request("POST", { cookie: "session=abc", "sec-fetch-site": "same-origin" }), {})).status).toBe(200);
    expect(isFromAnotherSite(request("DELETE", { cookie: "session=abc", "sec-fetch-site": "none" }))).toBe(false);
    // Reading changes nothing.
    expect(isFromAnotherSite(request("GET", { cookie: "session=abc", "sec-fetch-site": "cross-site" }))).toBe(false);
    // The desktop app and runners send a token, and no cookie is looked at.
    expect(isFromAnotherSite(request("POST", { authorization: `Bearer ${TOKEN}`, origin: "tauri://localhost", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(
      isFromAnotherSite(
        request("POST", { authorization: `Bearer ${TOKEN}`, cookie: "session=abc", origin: "http://tauri.localhost", "sec-fetch-site": "cross-site" }),
      ),
    ).toBe(false);
    // No cookie: nothing of the user's to borrow (a webhook, say).
    expect(isFromAnotherSite(request("POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isFromAnotherSite(request("POST", { origin: "https://elsewhere.example" }))).toBe(false);
  });

  it("are told apart by where the request says it came from when the browser doesn't say which site sent it", async () => {
    const cookie = { cookie: "session=abc" };
    // This site's own pages name it as the origin, or as the page they were on.
    expect(isFromAnotherSite(request("POST", { ...cookie, origin: "http://localhost:3000" }))).toBe(false);
    expect(isFromAnotherSite(request("POST", { ...cookie, referer: "http://localhost:3000/settings" }))).toBe(false);
    // Behind a proxy, the name people use is the one the proxy passes along.
    const proxied = { ...cookie, host: "127.0.0.1:3000", "x-forwarded-host": "app.example.com" };
    expect(isFromAnotherSite(request("POST", { ...proxied, origin: "https://app.example.com" }))).toBe(false);
    expect(isFromAnotherSite(request("POST", { ...proxied, origin: "https://elsewhere.example" }))).toBe(true);

    // Another site, a look-alike name, or a page that hides where it is.
    expect(isFromAnotherSite(request("POST", { ...cookie, origin: "https://elsewhere.example" }))).toBe(true);
    expect(isFromAnotherSite(request("DELETE", { ...cookie, origin: "http://localhost:3000.elsewhere.example" }))).toBe(true);
    expect(isFromAnotherSite(request("POST", { ...cookie, origin: "null" }))).toBe(true);
    expect(isFromAnotherSite(request("PATCH", { ...cookie, referer: "https://elsewhere.example/localhost:3000" }))).toBe(true);
    // The origin decides when both are sent.
    expect(isFromAnotherSite(request("POST", { ...cookie, origin: "https://elsewhere.example", referer: "http://localhost:3000/" }))).toBe(true);
    // Saying nothing at all isn't enough to use the cookie.
    expect(isFromAnotherSite(request("POST", cookie))).toBe(true);
    const res = await route(async () => json({ ok: true }))(request("POST", cookie), {});
    expect(res.status).toBe(403);

    // Reading is never refused, and a token still stands on its own.
    expect(isFromAnotherSite(request("GET", { ...cookie, origin: "https://elsewhere.example" }))).toBe(false);
    expect(isFromAnotherSite(request("POST", { authorization: `Bearer ${TOKEN}` }))).toBe(false);
  });
});

describe("signing in and out", () => {
  it("is only taken from this site's own pages, even before there is a cookie", () => {
    // The sign-in page asking for a code, with no cookie yet.
    expect(isSignInFromAnotherSite(request("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isSignInFromAnotherSite(request("POST", { origin: "http://localhost:3000" }))).toBe(false);
    // The sign-out button.
    expect(isSignInFromAnotherSite(request("POST", { cookie: "session=abc", "sec-fetch-site": "same-origin" }))).toBe(false);

    // Another site trying to sign someone in or out.
    expect(isSignInFromAnotherSite(request("POST", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isSignInFromAnotherSite(request("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isSignInFromAnotherSite(request("POST", { origin: "https://elsewhere.example" }))).toBe(true);
    expect(isSignInFromAnotherSite(request("POST", { cookie: "session=abc", "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isSignInFromAnotherSite(request("POST", { cookie: "session=abc" }))).toBe(true);
  });

  it("still lets someone come back from signing in elsewhere, which is a page load", () => {
    expect(isSignInFromAnotherSite(request("GET", { cookie: "state=abc", "sec-fetch-site": "cross-site", referer: "https://github.com/" }))).toBe(false);
    expect(isSignInFromAnotherSite(request("GET", { "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});
