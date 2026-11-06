import { NextResponse } from "next/server";
import { PolicyDenied, type PolicyDenied as PolicyDeniedBody } from "@lemonlime/protocol";
import type { PolicyDecision } from "@lemonlime/plugins";
import type { z } from "zod";

/** An error with an HTTP status and a JSON body, thrown from route code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json<T>(data: T, init?: number | ResponseInit): NextResponse<T> {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

/** Body for HTTP 402 when the usage policy declines. */
export function policyDeniedBody(decision: Extract<PolicyDecision, { allow: false }>): PolicyDeniedBody {
  const body = {
    error: "policy_denied" as const,
    reason: decision.reason,
    ...(decision.actionUrl ? { actionUrl: decision.actionUrl } : {}),
    ...(decision.actionLabel ? { actionLabel: decision.actionLabel } : {}),
  };
  const parsed = PolicyDenied.safeParse(body);
  // Drop an action link that is not a valid absolute URL rather than failing the request.
  return parsed.success ? parsed.data : { error: "policy_denied", reason: decision.reason };
}

export class PolicyDeniedError extends HttpError {
  constructor(decision: Extract<PolicyDecision, { allow: false }>) {
    const body = policyDeniedBody(decision);
    super(402, body.reason, body);
  }
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

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/** Turn thrown HttpErrors into JSON responses and anything else into a logged 500. */
export function route<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    try {
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
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 502: return "sandbox_error";
    default: return "error";
  }
}
