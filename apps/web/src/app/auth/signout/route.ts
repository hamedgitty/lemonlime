import { NextResponse } from "next/server";
import { getAuth } from "@/lib/better-auth.ts";
import { getAppContext } from "@/lib/env.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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
