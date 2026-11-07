import { describe, expect, it } from "vitest";
import { createAuth } from "../src/lib/better-auth.ts";
import { createTestApp } from "./helpers.ts";

async function signIn(app: Awaited<ReturnType<typeof createTestApp>>, email: string) {
  const auth = createAuth(app.ctx);
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
  const code = /\b(\d{6})\b/.exec(app.emails.at(-1)!.text)?.[1] ?? "";
  return auth.api.signInEmailOTP({ body: { email, otp: code } });
}

describe("plugin events", () => {
  it("tells the deployment about a new user once, and a failing hook never blocks sign-up", async () => {
    const app = await createTestApp();
    const created: { email: string | null; workspaceId: string }[] = [];
    app.ctx.plugin.events = { onUserCreated: async u => void created.push({ email: u.email, workspaceId: u.workspaceId }) };
    await signIn(app, "new@example.com");
    await signIn(app, "new@example.com");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ email: "new@example.com" });
    expect(created[0]!.workspaceId).toBeTruthy();

    app.ctx.plugin.events = {
      onUserCreated: async () => {
        throw new Error("mail is down");
      },
    };
    const result = await signIn(app, "other@example.com");
    expect(result.user.email).toBe("other@example.com");
  });
});
