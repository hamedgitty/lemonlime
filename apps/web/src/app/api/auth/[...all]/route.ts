import { NextResponse } from "next/server";
import { getAuth } from "@/lib/better-auth.ts";
import { EmailNotConfiguredError } from "@/lib/email.ts";
import { getAppContext } from "@/lib/env.ts";
import { FROM_ANOTHER_SITE, isSignInFromAnotherSite } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * Better Auth endpoints: email codes, GitHub sign-in, sessions. Anything that changes
 * something is only taken from this site's own pages. Coming back from GitHub is a plain
 * page load, which is never refused here.
 */
async function handle(request: Request): Promise<Response> {
  if (isSignInFromAnotherSite(request)) return NextResponse.json({ code: "FROM_ANOTHER_SITE", message: FROM_ANOTHER_SITE }, { status: 403 });
  const ctx = await getAppContext();
  // Better Auth reports success for code requests even when the email cannot be
  // sent (so responses do not reveal anything). A deployment with no email
  // transport at all should say so instead of failing silently.
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/email-otp/send-verification-otp") && ctx.email.name === "none") {
    const err = new EmailNotConfiguredError();
    console.error(`[lemonlime] ${err.message}`);
    return NextResponse.json(
      { code: "EMAIL_NOT_CONFIGURED", message: "This server cannot send sign-in emails yet. Ask its administrator to configure email." },
      { status: 503 },
    );
  }
  return getAuth(ctx).handler(request);
}

export const GET = handle;
export const POST = handle;
