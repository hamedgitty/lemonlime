import { betterAuth, type AuthContext } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { emailOTP } from "better-auth/plugins";
import { account, rateLimit, session, user, verification } from "@lemonlime/db";
import { createPersonalWorkspace } from "./access.ts";
import type { AppContext } from "./context.ts";
import { signInCodeEmail } from "./email.ts";
import { isThisComputer } from "./links.ts";
import { leftAsPlaceholder } from "./placeholder-secret.ts";
import { addressHeaders, callerAddress, hit, LIMITS, withCallerAddress } from "./rate-limit.ts";

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

/** True when the app's own address is one only this computer can reach. */
function onThisComputer(publicUrl: string): boolean {
  try {
    return isThisComputer(new URL(publicUrl).hostname);
  } catch {
    return false;
  }
}

function authSecret(ctx: AppContext): string | undefined {
  // The placeholder from .env.example is as public as no secret at all, so it counts as none.
  const secret = leftAsPlaceholder(ctx.vars.BETTER_AUTH_SECRET) ? undefined : ctx.vars.BETTER_AUTH_SECRET;
  // Without it Better Auth signs sessions with a built-in secret anyone can look up. That
  // is fine for trying things out on this computer, and nowhere else: so only outside
  // production, and only when the app's own address says it is this computer.
  const tryingOut = !ctx.production && onThisComputer(ctx.vars.LEMONLIME_PUBLIC_URL ?? "");
  if (!secret && !tryingOut) {
    throw new Error("BETTER_AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  }
  return secret || undefined;
}

const SEND_CODE_PATH = "/email-otp/send-verification-otp";
const ENTER_CODE_PATH = "/sign-in/email-otp";
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
 * Forgets a waiting sign-in code that can't be read back: one kept under a sign-in secret
 * that has changed since, or kept some other way than encrypted. Asking again then makes a
 * new code, and entering the old one is a wrong code rather than an error.
 */
async function forgetUnreadableCode(auth: Pick<AuthContext, "internalAdapter" | "secretConfig">, email: string): Promise<void> {
  const identifier = `sign-in-otp-${email.toLowerCase()}`;
  const waiting = await auth.internalAdapter.findVerificationValue(identifier);
  if (!waiting) return;
  // Kept as "<the code, encrypted>:<wrong tries so far>".
  const kept = waiting.value.slice(0, waiting.value.lastIndexOf(":"));
  try {
    await symmetricDecrypt({ key: auth.secretConfig, data: kept });
  } catch {
    await auth.internalAdapter.deleteVerificationByIdentifier(identifier);
  }
}

/**
 * Better Auth for this deployment: email one-time codes, plus GitHub when
 * GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are set. Every new user gets a
 * personal workspace (with them as owner) as soon as their row is created.
 */
export function createAuth(ctx: AppContext) {
  const baseURL = ctx.vars.LEMONLIME_PUBLIC_URL?.replace(/\/+$/, "") || undefined;
  const secret = authSecret(ctx);
  const auth = betterAuth({
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
    // The caller's address, for rate limiting: the platform's header on Workers, the one
    // written for each request below on Node.
    advanced: {
      ipAddress: { ipAddressHeaders: addressHeaders(ctx.runtime) },
    },
    hooks: {
      // Runs before a sign-in code is made or sent again. Over the limit, the request stops
      // here: the code already sent keeps working, nothing is emailed, and the answer looks
      // the same as when a code was sent, so it says nothing about the address.
      before: createAuthMiddleware(async c => {
        if (c.path !== SEND_CODE_PATH && c.path !== ENTER_CODE_PATH) return;
        const { email, type } = (c.body ?? {}) as { email?: unknown; type?: unknown };
        if (typeof email !== "string") return;
        if (c.path === SEND_CODE_PATH) {
          if (type !== "sign-in") return;
          const caller = callerAddress(ctx, c.request ?? c.headers ?? new Headers());
          if (!(await allowSignInCode(ctx, email, caller))) {
            console.warn("Skipped a sign-in code: too many for this address in the last hour.");
            return c.json({ success: true });
          }
        }
        await forgetUnreadableCode(c.context, email);
      }),
    },
    socialProviders: githubEnabled(ctx.vars) ? { github: { clientId: ctx.vars.GITHUB_CLIENT_ID!, clientSecret: ctx.vars.GITHUB_CLIENT_SECRET! } } : {},
    plugins: [
      emailOTP({
        otpLength: SIGN_IN_CODE_LENGTH,
        expiresIn: SIGN_IN_CODE_TTL_SECONDS,
        allowedAttempts: 5,
        // Asking again while a code is still waiting sends that same code and gives it
        // another ten minutes, so nobody can cancel the code in someone's inbox by asking
        // for another. That needs the code kept in a form it can be read back from:
        // encrypted with the sign-in secret, which the database alone doesn't give away.
        storeOTP: "encrypted",
        resendStrategy: "reuse",
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
  const handle = auth.handler;
  auth.handler = request => handle(withCallerAddress(ctx, request));
  return auth;
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
