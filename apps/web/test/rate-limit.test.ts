import { describe, expect, it } from "vitest";
import { verification } from "@lemonlime/db";
import { allowSignInCode, createAuth } from "../src/lib/better-auth.ts";
import { CALLER_HEADER, callerAddress, enforce, hit, LIMITS } from "../src/lib/rate-limit.ts";
import { noteSocketAddress, SOCKET_ADDRESS_HEADER } from "../src/lib/socket-address.ts";
import { createTestApp, TEST_ENV } from "./helpers.ts";

describe("rate limits", () => {
  it("counts per key in fixed windows", async () => {
    const { db } = await createTestApp();
    const limit = { max: 2, windowSeconds: 60 };
    const t0 = 1_000_000;
    expect((await hit(db, "k", limit, t0)).ok).toBe(true);
    expect((await hit(db, "k", limit, t0 + 1000)).ok).toBe(true);
    const third = await hit(db, "k", limit, t0 + 2000);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSeconds).toBe(58);
    expect((await hit(db, "other", limit, t0 + 2000)).ok).toBe(true);
    // A new window starts fresh.
    expect((await hit(db, "k", limit, t0 + 60_000)).ok).toBe(true);
  });

  it("enforce answers 429 with a plain message", async () => {
    const { db } = await createTestApp();
    const limit = { max: 1, windowSeconds: 3600 };
    await enforce(db, "tokens:u1", limit, "new tokens");
    await expect(enforce(db, "tokens:u1", limit, "new tokens")).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/^Too many new tokens\. Try again in \d+ minutes\.$/),
    });
  });

  /** A deployment on Node with one reverse proxy in front, which reports each caller's address. */
  const BEHIND_A_PROXY = { env: { LEMONLIME_TRUSTED_PROXIES: "1" } };

  async function sendCode(auth: ReturnType<typeof createAuth>, email: string, ip: string, more: Record<string, string> = {}) {
    return auth.handler(
      new Request(`${TEST_ENV.LEMONLIME_PUBLIC_URL}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ENV.LEMONLIME_PUBLIC_URL, "x-forwarded-for": ip, ...more },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
  }

  it("limits sign-in codes per IP", async () => {
    const { ctx, emails } = await createTestApp(BEHIND_A_PROXY);
    const auth = createAuth(ctx);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await sendCode(auth, `user${i}@example.com`, "203.0.113.7")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(emails).toHaveLength(3);
    expect((await sendCode(auth, "else@example.com", "203.0.113.8")).status).toBe(200);
  });

  it("counts callers together when nothing in front of the app says who they are", async () => {
    const { ctx, emails } = await createTestApp();
    const auth = createAuth(ctx);
    const statuses = [];
    // Each request claims a different address, in both places an address could be read from.
    for (let i = 0; i < 4; i++) statuses.push((await sendCode(auth, `user${i}@example.com`, `203.0.113.${i}`, { [CALLER_HEADER]: `198.51.100.${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(emails).toHaveLength(3);
  });

  it("limits the sign-in codes one caller can have sent to an address, without locking its owner out", async () => {
    const { ctx, db, emails } = await createTestApp(BEHIND_A_PROXY);
    const auth = createAuth(ctx);
    const stranger = "203.0.113.50";
    // The stranger has used up their share of codes for someone else's address.
    for (let i = 0; i < LIMITS.signInCodesPerEmail.max; i++) expect(await allowSignInCode(ctx, "Target@Example.com", stranger)).toBe(true);

    // One more from them: the answer looks the same, but no code is made or sent.
    const refused = await sendCode(auth, "target@example.com", stranger);
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({ success: true });
    expect(emails).toHaveLength(0);
    expect(await db.select().from(verification)).toHaveLength(0);

    // The owner, asking from somewhere else, still gets a code.
    const sent = await sendCode(auth, "target@example.com", "198.51.100.9");
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ success: true });
    expect(emails).toHaveLength(1);
    const [code] = await db.select().from(verification);
    expect(code).toBeDefined();

    // The stranger asking again doesn't replace the code the owner was just sent.
    expect((await sendCode(auth, "target@example.com", stranger)).status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(await db.select().from(verification)).toEqual([code]);
  });

  const codeIn = (email: { text: string } | undefined) => /\b(\d{6})\b/.exec(email?.text ?? "")?.[1];

  async function enterCode(auth: ReturnType<typeof createAuth>, email: string, otp: string, ip: string) {
    return auth.handler(
      new Request(`${TEST_ENV.LEMONLIME_PUBLIC_URL}/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ENV.LEMONLIME_PUBLIC_URL, "x-forwarded-for": ip },
        body: JSON.stringify({ email, otp }),
      }),
    );
  }

  it("sends the code that is still waiting again, so a stranger asking for one can't cancel the owner's", async () => {
    const { ctx, emails } = await createTestApp(BEHIND_A_PROXY);
    const auth = createAuth(ctx);
    await sendCode(auth, "target@example.com", "198.51.100.9");
    const code = codeIn(emails[0]);
    expect(code).toMatch(/^\d{6}$/);

    // Someone else asks for a code for the same address: the owner is sent the same one.
    expect((await sendCode(auth, "Target@Example.com", "203.0.113.50")).status).toBe(200);
    expect(emails).toHaveLength(2);
    expect(codeIn(emails[1])).toBe(code);

    // The code from the first email still signs the owner in, and only once.
    expect((await enterCode(auth, "target@example.com", code!, "198.51.100.9")).status).toBe(200);
    expect((await enterCode(auth, "target@example.com", code!, "198.51.100.9")).status).toBe(400);

    // A used code is not sent again: the next request gets a new one.
    await sendCode(auth, "target@example.com", "198.51.100.9");
    expect(emails).toHaveLength(3);
    expect(codeIn(emails[2])).toMatch(/^\d{6}$/);
  });

  it("makes a new code once the tries at the waiting one are used up", async () => {
    const { ctx, emails } = await createTestApp(BEHIND_A_PROXY);
    const auth = createAuth(ctx);
    await sendCode(auth, "target@example.com", "198.51.100.9");
    const code = codeIn(emails[0])!;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await enterCode(auth, "target@example.com", wrong, "203.0.113.50")).status).toBe(400);

    await sendCode(auth, "target@example.com", "198.51.100.9");
    const next = codeIn(emails[1])!;
    expect(next).toMatch(/^\d{6}$/);
    expect((await enterCode(auth, "target@example.com", next, "198.51.100.9")).status).toBe(200);
  });

  it("keeps a waiting code in a form the database alone doesn't give away", async () => {
    const { ctx, db, emails } = await createTestApp(BEHIND_A_PROXY);
    await sendCode(createAuth(ctx), "target@example.com", "198.51.100.9");
    const [kept] = await db.select().from(verification);
    expect(kept!.value).not.toContain(codeIn(emails[0])!);
  });

  it("forgets a waiting code it can no longer read, instead of failing", async () => {
    const { ctx, db, emails } = await createTestApp(BEHIND_A_PROXY);
    const auth = createAuth(ctx);
    const owner = "198.51.100.9";
    await sendCode(auth, "target@example.com", owner);
    // What a code looks like once the sign-in secret has changed, or when it was kept hashed.
    const unreadable = async () => void (await db.update(verification).set({ value: "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg:0" }));

    // Entering it is a wrong code.
    await unreadable();
    expect((await enterCode(auth, "target@example.com", codeIn(emails[0])!, owner)).status).toBe(400);
    expect(await db.select().from(verification)).toHaveLength(0);

    // Asking again makes a new one, which works.
    await sendCode(auth, "target@example.com", owner);
    await unreadable();
    expect((await sendCode(auth, "target@example.com", owner)).status).toBe(200);
    expect(emails).toHaveLength(3);
    expect((await enterCode(auth, "target@example.com", codeIn(emails[2])!, owner)).status).toBe(200);
  });

  it("limits the sign-in codes sent to one address, however many callers ask", async () => {
    const { ctx, db, emails } = await createTestApp(BEHIND_A_PROXY);
    const auth = createAuth(ctx);
    const allowed = [];
    for (let i = 0; i < LIMITS.signInCodesPerEmailFromAnyone.max + 5; i++) allowed.push(await allowSignInCode(ctx, "target@example.com", `198.51.100.${i}`));
    expect(allowed.filter(Boolean)).toHaveLength(LIMITS.signInCodesPerEmailFromAnyone.max);
    expect(allowed.slice(-5)).toEqual([false, false, false, false, false]);

    const res = await sendCode(auth, "target@example.com", "192.0.2.77");
    expect(res.status).toBe(200);
    expect(emails).toHaveLength(0);
    expect(await db.select().from(verification)).toHaveLength(0);
    // Other addresses are not affected.
    expect(await allowSignInCode(ctx, "other@example.com", "192.0.2.77")).toBe(true);
  });

  const on = (runtime: "workers" | "node", proxies?: string) => ({
    runtime,
    production: false,
    vars: proxies === undefined ? {} : { LEMONLIME_TRUSTED_PROXIES: proxies },
  });
  const from = (ctx: ReturnType<typeof on>, headers: Record<string, string>) => callerAddress(ctx, new Headers(headers));

  it("tells callers apart by the address the platform reports on Workers", () => {
    expect(from(on("workers"), { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })).toBe("203.0.113.7");
    expect(from(on("workers"), { "cf-connecting-ip": "203.0.113.7" })).not.toBe(from(on("workers"), { "cf-connecting-ip": "203.0.113.8" }));
  });

  it("doesn't believe X-Forwarded-For on Node unless a proxy is said to be in front", () => {
    const nobody = from(on("node"), {});
    expect(from(on("node"), { "x-forwarded-for": "203.0.113.7" })).toBe(nobody);
    expect(from(on("node", "0"), { "x-forwarded-for": "203.0.113.7" })).toBe(nobody);
    // A setting that isn't a whole number of proxies is no proxies.
    for (const odd of ["yes", "-1", "1.5", ""]) expect(from(on("node", odd), { "x-forwarded-for": "203.0.113.7" })).toBe(nobody);
  });

  it("takes the address the last trusted proxy added, not what the caller wrote before it", () => {
    expect(from(on("node", "1"), { "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
    expect(from(on("node", "1"), { "x-forwarded-for": "198.51.100.1, 203.0.113.7" })).toBe("203.0.113.7");
    // With two proxies the last entry is the first proxy, and the caller is the one before it.
    expect(from(on("node", "2"), { "x-forwarded-for": "198.51.100.1, 203.0.113.7, 10.0.0.2" })).toBe("203.0.113.7");
    // Too few entries for the proxies there should be: nobody in particular.
    const nobody = from(on("node", "2"), {});
    expect(from(on("node", "2"), { "x-forwarded-for": "203.0.113.7" })).toBe(nobody);
    // Something that isn't an address is never counted under what it says.
    const unreadable = from(on("node", "1"), { "x-forwarded-for": "not an address" });
    expect(unreadable).not.toBe("not an address");
    expect(from(on("node", "1"), { "x-forwarded-for": "203.0.113.7, neither is this" })).toBe(unreadable);
  });

  it("counts one IPv6 network as one caller", () => {
    const node = on("node", "1");
    expect(from(node, { "x-forwarded-for": "2001:db8:1:2::1" })).toBe(from(node, { "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }));
    expect(from(node, { "x-forwarded-for": "2001:db8:1:2::1" })).not.toBe(from(node, { "x-forwarded-for": "2001:db8:1:3::1" }));
  });

  it("uses where the connection came from once the app's own server writes it down", () => {
    const node = on("node");
    // Until then a header claiming to be that could be anyone's.
    expect(from(node, { [SOCKET_ADDRESS_HEADER]: "203.0.113.7" })).toBe(from(node, {}));

    const request = {
      headers: { [SOCKET_ADDRESS_HEADER]: "203.0.113.7", "x-forwarded-for": "203.0.113.8" } as Record<string, string>,
      socket: { remoteAddress: "::ffff:198.51.100.4" },
    };
    noteSocketAddress(request);
    expect(from(node, request.headers)).toBe("198.51.100.4");
    // A connection with no address leaves nothing of the caller's claim behind.
    const unknown = { headers: { [SOCKET_ADDRESS_HEADER]: "203.0.113.7" } as Record<string, string>, socket: {} };
    noteSocketAddress(unknown);
    expect(from(node, unknown.headers)).toBe(from(node, {}));
    // Behind a proxy, the proxy's word is taken over its own address.
    expect(from(on("node", "1"), { ...request.headers, "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
  });
});
