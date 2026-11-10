import { describe, expect, it } from "vitest";
import { isFromAnotherSite, json, route } from "../src/lib/http.ts";

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
    // Programs that don't say where a request came from.
    expect(isFromAnotherSite(request("POST", { cookie: "session=abc" }))).toBe(false);
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
  });
});
