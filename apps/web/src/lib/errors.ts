import { PolicyDenied, type PolicyDenied as PolicyDeniedBody } from "@lemonlime/protocol";
import type { PolicyDecision } from "@lemonlime/plugins";

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
