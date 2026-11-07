import { describe, expect, it } from "vitest";
import { createAuth } from "../src/lib/better-auth.ts";
import { enforce, hit } from "../src/lib/rate-limit.ts";
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

  async function sendCode(auth: ReturnType<typeof createAuth>, email: string, ip: string) {
    return auth.handler(
      new Request(`${TEST_ENV.LEMONLIME_PUBLIC_URL}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ENV.LEMONLIME_PUBLIC_URL, "x-forwarded-for": ip },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
  }

  it("limits sign-in codes per IP", async () => {
    const { ctx, emails } = await createTestApp();
    const auth = createAuth(ctx);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await sendCode(auth, `user${i}@example.com`, "203.0.113.7")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(emails).toHaveLength(3);
    expect((await sendCode(auth, "else@example.com", "203.0.113.8")).status).toBe(200);
  });

  it("limits sign-in codes per email address, whatever the IP", async () => {
    const { ctx, emails } = await createTestApp();
    const auth = createAuth(ctx);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await sendCode(auth, "Target@Example.com", `198.51.100.${i}`)).status);
    // Every answer looks the same (no hint about the address), but only 5 emails go out.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    expect(emails).toHaveLength(5);
  });
});
