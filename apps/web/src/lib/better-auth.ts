import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { account, rateLimit, session, user, verification } from "@lemonlime/db";
import { createPersonalWorkspace } from "./access.ts";
import type { AppContext } from "./context.ts";
import { signInCodeEmail } from "./email.ts";
import { addressHeaders, callerAddress, hit, LIMITS } from "./rate-limit.ts";

/** Sign-in codes are 6 digits and valid for 10 minutes. */
export const SIGN_IN_CODE_LENGTH = 6;
export const SIGN_IN_CODE_TTL_SECONDS = 10 * 60;

/** What a stored sign-in account keeps of the provider's tokens: nothing. */
export const FORGET_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
} as const;

export function githubEnabled(vars: AppContext["vars"]): boolean {
  return Boolean(vars.GITHUB_CLIENT_ID && vars.GITHUB_CLIENT_SECRET);
}

/** True for an address only this computer can reach (localhost, 127.0.0.1, [::1], *.localhost). */
function isThisComputer(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function authSecret(ctx: AppContext): string | undefined {
  const secret = ctx.vars.BETTER_AUTH_SECRET;
  // Without it Better Auth signs sessions with a built-in secret anyone can look up. That
  // is fine for trying things out on this computer, and nowhere else.
  const reachable = Boolean(ctx.vars.LEMONLIME_PUBLIC_URL) && !isThisComputer(ctx.vars.LEMONLIME_PUBLIC_URL!);
  if (!secret && (ctx.production || reachable)) {
    throw new Error("BETTER_AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  }
  return secret || undefined;
}

const SEND_CODE_PATH = "/email-otp/send-verification-otp";
/** Longer than any real email address. */
const EMAIL_MAX = 254;

/**
 * Counts one request for a sign-in code and says whether to send it. Counted for the
 * address and the caller together first, so someone asking again and again for another
 * person's address uses up only their own share and can't lock that person out. Then for
 * the address whoever asks, so many callers together can't flood one inbox.
 */
export async function allowSignInCode(ctx: AppContext, email: string, caller: string): Promise<boolean> {
  const address = email.trim().toLowerCase();
  if (address.length > EMAIL_MAX) return false;
  const fromCaller = await hit(ctx.db, `sign-in-code:${address}:from:${caller}`, LIMITS.signInCodesPerEmail);
  if (!fromCaller.ok) return false;
  return (await hit(ctx.db, `sign-in-code:${address}`, LIMITS.signInCodesPerEmailFromAnyone)).ok;
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
      schema: { user, session, account, verification, rateLimit },
      // D1 has no interactive transactions.
      transaction: false,
    }),
    emailAndPassword: { enabled: false },
    // Counted in the database so every Worker isolate shares the counts (Better Auth's
    // default keeps them in memory, per isolate). Per client IP; tighter for codes.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "rateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    // Client IP for rate limiting. On Workers, Cloudflare sets cf-connecting-ip; on Node,
    // put the app behind a proxy that sets x-forwarded-for.
    advanced: {
      ipAddress: { ipAddressHeaders: addressHeaders(ctx.runtime) },
    },
    hooks: {
      // Runs before a new sign-in code is made. Over the limit, the request stops here: the
      // code already sent keeps working, nothing is emailed, and the answer looks the same
      // as when a code was sent, so it says nothing about the address.
      before: createAuthMiddleware(async c => {
        if (c.path !== SEND_CODE_PATH) return;
        const { email, type } = (c.body ?? {}) as { email?: unknown; type?: unknown };
        if (typeof email !== "string" || type !== "sign-in") return;
        const caller = callerAddress(ctx.runtime, c.request ?? c.headers ?? new Headers());
        if (await allowSignInCode(ctx, email, caller)) return;
        console.warn("Skipped a sign-in code: too many for this address in the last hour.");
        return c.json({ success: true });
      }),
    },
    socialProviders: githubEnabled(ctx.vars) ? { github: { clientId: ctx.vars.GITHUB_CLIENT_ID!, clientSecret: ctx.vars.GITHUB_CLIENT_SECRET! } } : {},
    plugins: [
      emailOTP({
        otpLength: SIGN_IN_CODE_LENGTH,
        expiresIn: SIGN_IN_CODE_TTL_SECONDS,
        allowedAttempts: 5,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return; // only sign-in codes are used
          // How many codes one address gets is limited before this point (see `hooks` above).
          await ctx.email.send(signInCodeEmail(ctx.config.emailBrand(), email, otp, SIGN_IN_CODE_TTL_SECONDS / 60));
        },
      }),
    ],
    databaseHooks: {
      // GitHub only proves who someone is; LemonLime never calls GitHub with their sign-in
      // token (repositories go through the GitHub App), so the tokens are never kept.
      account: {
        create: { before: async data => ({ data: { ...data, ...FORGET_TOKENS } }) },
        update: { before: async data => ({ data: { ...data, ...FORGET_TOKENS } }) },
      },
      user: {
        create: {
          async after(created) {
            const workspaceId = await createPersonalWorkspace(ctx.db, created.id, created.email);
            // A deployment's welcome email or similar; it must never stop someone signing up.
            await ctx.plugin.events
              .onUserCreated?.({ userId: created.id, email: created.email ?? null, workspaceId })
              .catch(err => console.error("[lemonlime] onUserCreated failed:", err));
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
