import { describe, expect, it } from "vitest";
import { accessTokens, desktopApprovals } from "@lemonlime/db";
import { findUserByTokenHash } from "../src/lib/access.ts";
import { hashAccessToken, looksLikeAccessToken } from "../src/lib/access-tokens.ts";
import { approveDesktop, DESKTOP_LINK_USED, isFromOwnForm } from "../src/lib/desktop-connect.ts";
import { addUser, createTestApp, TEST_ENV } from "./helpers.ts";

const STATE = "Zm9vYmFyYmF6cXV4MTIzNDU2";

function post(headers: Record<string, string>): Request {
  return new Request(`${TEST_ENV.LEMONLIME_PUBLIC_URL}/desktop/connect/approve`, { method: "POST", headers });
}

describe("connecting the desktop app", () => {
  it("makes one token for the person who confirmed, and hands it back with the app's own state", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const { link } = await approveDesktop(app.ctx, alice.userId, STATE, new Date("2026-03-04T10:00:00Z"));
    const url = new URL(link);
    expect(url.protocol).toBe("lemonlime:");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("url")).toBe(TEST_ENV.LEMONLIME_PUBLIC_URL);
    const token = url.searchParams.get("token")!;
    expect(looksLikeAccessToken(token)).toBe(true);
    expect(await findUserByTokenHash(app.db, hashAccessToken(token))).toBe(alice.userId);
    expect((await app.db.select().from(accessTokens)).map(t => t.name)).toEqual(["Desktop app (2026-03-04)"]);
  });

  it("refuses a link that was already used, so going back and confirming again makes no second token", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    const bob = await addUser(app.db, "bob@example.com");
    await approveDesktop(app.ctx, alice.userId, STATE);
    await expect(approveDesktop(app.ctx, alice.userId, STATE)).rejects.toMatchObject({ status: 409, message: DESKTOP_LINK_USED });
    // Someone else who got hold of the link can't use it either.
    await expect(approveDesktop(app.ctx, bob.userId, STATE)).rejects.toMatchObject({ status: 409, message: DESKTOP_LINK_USED });
    expect(await app.db.select().from(accessTokens)).toHaveLength(1);
    // A fresh link from the app works.
    await approveDesktop(app.ctx, alice.userId, `${STATE}-again`);
    expect(await app.db.select().from(accessTokens)).toHaveLength(2);
  });

  it("keeps only a hash of the link's state", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    await approveDesktop(app.ctx, alice.userId, STATE);
    const [note] = await app.db.select().from(desktopApprovals);
    expect(note!.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(note!.stateHash).not.toContain(STATE);
  });

  it("refuses a state the app could not have made, without using anything up", async () => {
    const app = await createTestApp();
    const alice = await addUser(app.db, "alice@example.com");
    for (const state of ["", "short", "has spaces in it, which no app sends", "x".repeat(200)]) {
      await expect(approveDesktop(app.ctx, alice.userId, state)).rejects.toMatchObject({ status: 400 });
    }
    expect(await app.db.select().from(accessTokens)).toHaveLength(0);
    expect(await app.db.select().from(desktopApprovals)).toHaveLength(0);
  });

  it("is only taken from this site's own form", () => {
    const site = TEST_ENV.LEMONLIME_PUBLIC_URL;
    expect(isFromOwnForm(post({ origin: site }), site)).toBe(true);
    expect(isFromOwnForm(post({ origin: site }), `${site}/`)).toBe(true);
    expect(isFromOwnForm(post({ origin: "https://elsewhere.example" }), site)).toBe(false);
    expect(isFromOwnForm(post({ origin: "null" }), site)).toBe(false);
    // A request that doesn't say where it came from isn't the form.
    expect(isFromOwnForm(post({}), site)).toBe(false);
    expect(isFromOwnForm(post({ referer: `${site}/desktop/connect` }), site)).toBe(false);
  });
});
