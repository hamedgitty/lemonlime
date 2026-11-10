import { NextResponse, type NextRequest } from "next/server";

/** Everything a page's policy says besides which scripts may run. Keep it the same as the one in next.config.ts. */
const PAGE_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

/**
 * Gives every page view a one-time value, and a Content-Security-Policy under which only
 * scripts that carry it run, along with whatever those scripts load themselves. A script
 * that got into a page any other way is not run.
 *
 * Next.js reads the value from the policy on the request and puts it on its own script
 * tags; a route that writes its own page reads it from x-nonce. Both headers are set here,
 * over anything the browser sent under those names.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  // React's development build rebuilds error stacks with eval; a production build never uses it.
  const scripts = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`;
  const policy = `${PAGE_POLICY}; ${scripts}`;

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

/** Pages only: API routes and static files keep the policy from next.config.ts. */
export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };
