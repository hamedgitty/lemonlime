import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { account, session, user, verification } from "@lemonlime/db";
import { createPersonalWorkspace } from "./access.ts";
import type { AppContext } from "./context.ts";
import { signInCodeEmail } from "./email.ts";

/** Sign-in codes are 6 digits and valid for 10 minutes. */
export const SIGN_IN_CODE_LENGTH = 6;
export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60;

export function githubEnabled(vars: AppContext["vars"]): boolean {
  return Boolean(vars.GITHUB_CLIENT_ID && vars.GITHUB_CLIENT_SECRET);
}

function authSecret(ctx: AppContext): string | undefined {
  const secret = ctx.vars.BETTER_AUTH_SECRET;
  if (!secret && ctx.production) {
    throw new Error("BETTER_AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  }
  // In development Better Auth falls back to a built-in secret and warns.
  return secret || undefined;
}

/**
 * Better Auth for this deployment: email one-time codes, plus GitHub when
 * GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are set. Every new user gets a
 * personal workspace (with them as owner) as soon as their row is created.
 */
export function createAuth(ctx: AppContext) {
  const baseURL = ctx.vars.LEMONLIME_PUBLIC_URL?.replace(/\/+$/, "") || undefined;
  const secret = authSecret(ctx);
  return betterAuth({
    appName: "LemonLime",
    ...(baseURL ? { baseURL } : {}),
    ...(secret ? { secret } : {}),
    ...(baseURL ? { trustedOrigins: [baseURL] } : {}),
    database: drizzleAdapter(ctx.db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
      // D1 has no interactive transactions.
      transaction: false,
    }),
    emailAndPassword: { enabled: false },
    // Client IP for rate limiting. On Workers, Cloudflare sets cf-connecting-ip; on Node,
    // put the app behind a proxy that sets x-forwarded-for.
    advanced: {
      ipAddress: { ipAddressHeaders: ctx.runtime === "workers" ? ["cf-connecting-ip"] : ["x-forwarded-for"] },
    },
    socialProviders: githubEnabled(ctx.vars)
      ? { github: { clientId: ctx.vars.GITHUB_CLIENT_ID!, clientSecret: ctx.vars.GITHUB_CLIENT_SECRET! } }
      : {},
    plugins: [
      emailOTP({
        otpLength: SIGN_IN_CODE_LENGTH,
        expiresIn: SIGN_IN_CODE_TTL_SECONDS,
        allowedAttempts: 5,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return; // only sign-in codes are used
          await ctx.email.send(signInCodeEmail(email, otp, SIGN_IN_CODE_TTL_SECONDS / 60));
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          async after(created) {
            await createPersonalWorkspace(ctx.db, created.id, created.email);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const instances = new WeakMap<AppContext, Auth>();

/** One Better Auth instance per app context. */
export function getAuth(ctx: AppContext): Auth {
  let auth = instances.get(ctx);
  if (!auth) {
    auth = createAuth(ctx);
    instances.set(ctx, auth);
  }
  return auth;
}
