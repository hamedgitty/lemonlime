// The subagents MCP server agent CLIs start (stdio, JSON-RPC): `lemonlime-runner subagents-mcp`.
// Three tools, each a call to this thread's runner. Env (set by the runner for its agents):
// LEMONLIME_RUNNER_URL, LEMONLIME_THREAD_ID, LEMONLIME_THREAD_SECRET, and for subagents
// themselves LEMONLIME_SUBAGENT_ID (so their own subagents are theirs).
import { createInterface } from "node:readline";
import { signToken } from "@lemonlime/protocol";

type Json = Record<string, unknown>;

const TOOLS = [
  {
    name: "spawn_subagent",
    description:
      "Start a subagent: another agent that works on one part of the task in this same project while you carry on. Its reply comes back to you as a message when it's done. Give it a self-contained task. At most 3 at a time, 2 levels deep.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Any id you choose for this request; sending the same one again never starts a second subagent." },
        task: { type: "string", description: "What the subagent should do, with everything it needs to know." },
      },
      required: ["request_id", "task"],
    },
  },
  { name: "list_subagents", description: "Your subagents: what each is doing, and its last reply.", inputSchema: { type: "object", properties: {} } },
  {
    name: "message_subagent",
    description: "Send one of your subagents a follow-up. It answers as a message, like its first reply.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
  },
];

async function call(env: NodeJS.ProcessEnv, path: string, body?: Json): Promise<{ ok: boolean; data: Json }> {
  const base = env.LEMONLIME_RUNNER_URL;
  const threadId = env.LEMONLIME_THREAD_ID;
  const secret = env.LEMONLIME_THREAD_SECRET;
  if (!base || !threadId || !secret) return { ok: false, data: { error: "Subagents only work inside a LemonLime thread." } };
  const token = await signToken({ threadId, scope: "runner", exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const parent = env.LEMONLIME_SUBAGENT_ID ? `?parent=${encodeURIComponent(env.LEMONLIME_SUBAGENT_ID)}` : "";
  const res = await fetch(`${base}${path}${parent}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => null);
  if (!res) return { ok: false, data: { error: "Couldn't reach the runner." } };
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Json };
}

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export async function runSubagentTool(name: string, args: Json, env: NodeJS.ProcessEnv = process.env) {
  if (name === "spawn_subagent") {
    const r = await call(env, "/subagents/spawn", { requestId: String(args.request_id ?? ""), task: String(args.task ?? "") });
    return r.ok
      ? text(`Started subagent ${r.data.id}. Its reply will come to you as a message; carry on meanwhile.`)
      : text(String(r.data.error ?? "Couldn't start it."), true);
  }
  if (name === "list_subagents") {
    const r = await call(env, "/subagents");
    return r.ok ? text(JSON.stringify(r.data.subagents ?? [], null, 2)) : text(String(r.data.error ?? "Couldn't list them."), true);
  }
  if (name === "message_subagent") {
    const r = await call(env, "/subagents/message", { id: String(args.id ?? ""), text: String(args.text ?? "") });
    return r.ok ? text("Sent. Its answer will come to you as a message.") : text(String(r.data.error ?? "Couldn't send it."), true);
  }
  return text(`Unknown tool ${name}`, true);
}

/** Serve MCP on stdin/stdout until stdin closes. */
export function runSubagentsMcp(env: NodeJS.ProcessEnv = process.env): void {
  const send = (msg: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  createInterface({ input: process.stdin }).on("line", async line => {
    let msg: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Json } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (!("id" in msg)) return;
    switch (msg.method) {
      case "initialize":
        return send({
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "lemonlime-subagents", version: "1" },
          },
        });
      case "tools/list":
        return send({ id: msg.id, result: { tools: TOOLS } });
      case "tools/call":
        return send({ id: msg.id, result: await runSubagentTool(msg.params?.name ?? "", msg.params?.arguments ?? {}, env) });
      case "ping":
        return send({ id: msg.id, result: {} });
      default:
        return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  });
}
