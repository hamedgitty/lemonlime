import { PolicyDenied, type PolicyDenied as PolicyDeniedBody } from "@lemonlime/protocol";
import type { PolicyDecision } from "@lemonlime/plugins";
import { withSafeLink } from "./links.ts";

/** An error with an HTTP status and a JSON body, thrown from route and library code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Body for HTTP 402 when the usage policy declines. Its link is passed on only when it is safe to offer. */
export function policyDeniedBody(decision: Extract<PolicyDecision, { allow: false }>): PolicyDeniedBody {
  // A link that isn't one is dropped, with its label, rather than failing the request.
  const { reason, actionUrl, actionLabel } = withSafeLink(decision);
  const body = {
    error: "policy_denied" as const,
    reason,
    ...(actionUrl ? { actionUrl } : {}),
    ...(actionLabel ? { actionLabel } : {}),
  };
  const parsed = PolicyDenied.safeParse(body);
  return parsed.success ? parsed.data : { error: "policy_denied", reason };
}

export class PolicyDeniedError extends HttpError {
  constructor(decision: Extract<PolicyDecision, { allow: false }>) {
    const body = policyDeniedBody(decision);
    super(402, body.reason, body);
  }
}
