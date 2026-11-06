import { NextResponse } from "next/server";
import type { z } from "zod";
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
