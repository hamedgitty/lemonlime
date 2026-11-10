import { NextResponse } from "next/server";
import { getAuth } from "@/lib/better-auth.ts";
import { getAppContext } from "@/lib/env.ts";
import { FROM_ANOTHER_SITE, isSignInFromAnotherSite, json } from "@/lib/http.ts";

export const dynamic = "force-dynamic";

/** Signs the browser out. Only this site's own sign-out button may ask: another site can't sign someone out behind their back. */
export async function POST(request: Request) {
  if (isSignInFromAnotherSite(request)) return json({ error: "forbidden", message: FROM_ANOTHER_SITE }, 403);
  const ctx = await getAppContext();
  const redirect = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  try {
    const res = await getAuth(ctx).api.signOut({ headers: request.headers, asResponse: true });
    // Carry over the cookie-clearing headers.
    for (const cookie of res.headers.getSetCookie()) redirect.headers.append("set-cookie", cookie);
  } catch {
    // No session: nothing to clear.
  }
  return redirect;
}
