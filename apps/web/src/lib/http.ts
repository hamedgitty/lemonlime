import { NextResponse } from "next/server";
import type { z } from "zod";
import { bearerToken } from "./access-tokens.ts";
import { HttpError } from "./errors.ts";

export { HttpError, PolicyDeniedError, policyDeniedBody } from "./errors.ts";

export function json<T>(data: T, init?: number | ResponseInit): NextResponse<T> {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

/** Parse a JSON body with a Zod schema, or throw a 400. */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, "Invalid request body.", {
      error: "bad_request",
      message: "Invalid request body.",
      issues: result.error.issues.map(i => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}

export const FROM_ANOTHER_SITE = "That request came from another site.";

/**
 * For changes that can't be undone: refuse requests a browser says came from another site.
 * (The session cookie is SameSite=Lax already; this is a second lock.)
 */
export function requireSameSite(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, FROM_ANOTHER_SITE);
}

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The host names this request was addressed to: what the browser put in `Host`, what a
 * proxy in front passed along, and the address the server saw. A page on another site
 * can't choose any of them, so a request that names one of these as its origin came from here.
 */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (host: string | null | undefined) => {
    const name = host?.split(",")[0]?.trim().toLowerCase();
    if (name) hosts.add(name);
  };
  add(request.headers.get("host"));
  add(request.headers.get("x-forwarded-host"));
  try {
    add(new URL(request.url).host);
  } catch {
    // A request with no usable address has no host of its own to add.
  }
  return hosts;
}

/**
 * Whether the page that sent a request is one of this site's own, as far as the browser
 * says: by `Sec-Fetch-Site` when it sends that, otherwise by `Origin`, or by `Referer` when
 * there is no `Origin`. Null when the request says nothing about where it came from.
 */
function cameFromThisSite(request: Request): boolean | null {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const from = request.headers.get("origin") ?? request.headers.get("referer");
  if (!from) return null;
  let host: string;
  try {
    host = new URL(from).host.toLowerCase();
  } catch {
    return false; // "null" (a sandboxed or privacy-stripped page), or anything else that isn't an address
  }
  return host !== "" && ownHosts(request).has(host);
}

/**
 * True when a request that changes something relies on the browser's sign-in cookie and
 * can't be shown to come from this site's own pages: the browser says another site sent
 * it, names another site as its origin, or names none at all. Requests that carry a token
 * instead (the desktop app, runners, scheduled jobs) or no cookie at all are never refused
 * here: they hold nothing of the user's that another site could borrow.
 */
export function isFromAnotherSite(request: Request): boolean {
  if (!CHANGES.has(request.method.toUpperCase())) return false;
  if (!request.headers.get("cookie") || bearerToken(request.headers.get("authorization"))) return false;
  return cameFromThisSite(request) !== true;
}

/**
 * The same question for signing in and out, which only this site's own pages ever ask for.
 * Another site doesn't need the cookie to sign someone in to an account that isn't theirs,
 * so a browser that says the request came from elsewhere is refused with or without one.
 */
export function isSignInFromAnotherSite(request: Request): boolean {
  if (!CHANGES.has(request.method.toUpperCase())) return false;
  const here = cameFromThisSite(request);
  return here === false || (here === null && Boolean(request.headers.get("cookie")));
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/**
 * Turn thrown HttpErrors into JSON responses and anything else into a logged 500. Changes
 * asked for by another site with the user's cookie are refused before the handler runs.
 */
export function route<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    try {
      if (isFromAnotherSite(request)) throw new HttpError(403, FROM_ANOTHER_SITE);
      return await handler(request, context);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(err.body ?? { error: errorCode(err.status), message: err.message }, err.status);
      }
      console.error(`[lemonlime] ${request.method} ${new URL(request.url).pathname} failed:`, err);
      return json({ error: "internal", message: "Something went wrong." }, 500);
    }
  };
}

function errorCode(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 502:
      return "sandbox_error";
    default:
      return "error";
  }
}
