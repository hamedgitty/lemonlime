import * as agentCredentials from "@/app/api/runner/agent-credentials/route.ts";
import * as gitCredentials from "@/app/api/runner/git-credentials/route.ts";
import * as heartbeat from "@/app/api/runner/heartbeat/route.ts";
import * as history from "@/app/api/runner/history/route.ts";
import * as inbox from "@/app/api/runner/inbox/route.ts";
import type { RunnerCallDispatch } from "./relay.ts";

type Handler = (request: Request, context: never) => Promise<Response>;

/** The runner routes a relayed call may reach: exactly the ones a runner calls itself. */
const ROUTES: Record<string, Partial<Record<"GET" | "POST", Handler>>> = {
  "/api/runner/heartbeat": heartbeat as never,
  "/api/runner/history": history as never,
  "/api/runner/inbox": inbox as never,
  "/api/runner/git-credentials": gitCredentials as never,
  "/api/runner/agent-credentials": agentCredentials as never,
};

/** Make a relayed runner call in-process, through the same route (and its checks) as a direct one. */
export const dispatchRunnerCall: RunnerCallDispatch = async request => {
  const handler = ROUTES[new URL(request.url).pathname]?.[request.method as "GET" | "POST"];
  if (!handler) return new Response(JSON.stringify({ error: "not_found", message: "No such runner route." }), { status: 404 });
  return handler(request, {} as never);
};
