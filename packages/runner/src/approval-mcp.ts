// The approval helper Claude Code starts as an MCP server (stdio, JSON-RPC) through
// --permission-prompt-tool. One tool, `approve`, forwards the question to the runner and
// returns the user's answer. Run as `lemonlime-runner approval-mcp`.
//
// Env: LEMONLIME_APPROVAL_URL, LEMONLIME_APPROVAL_TOKEN (set by the runner).
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

const TOOL = {
  name: "approve",
  description: "Ask the LemonLime user whether the agent may use a tool.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

function summarize(tool: string, input: Json): string {
  for (const key of ["command", "file_path", "path", "url", "pattern"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return tool;
}

async function ask(url: string, token: string, args: { tool_name?: unknown; input?: unknown } | undefined) {
  const tool = String(args?.tool_name ?? "tool");
  const input = (args?.input && typeof args.input === "object" ? args.input : {}) as Json;
  let decision = "deny";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, input, summary: summarize(tool, input) }),
    });
    if (res.ok) decision = ((await res.json()) as { decision?: string }).decision === "allow" ? "allow" : "deny";
  } catch {
    decision = "deny";
  }
  const answer =
    decision === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user did not allow this. Ask them, or try another way." };
  return { content: [{ type: "text", text: JSON.stringify(answer) }] };
}

/** Serve MCP on stdin/stdout until stdin closes. */
export function runApprovalMcp(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.LEMONLIME_APPROVAL_URL ?? "";
  const token = env.LEMONLIME_APPROVAL_TOKEN ?? "";
  const send = (msg: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  createInterface({ input: process.stdin }).on("line", async line => {
    let msg: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: { tool_name?: unknown; input?: unknown } } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (!("id" in msg)) return; // notifications need no answer
    switch (msg.method) {
      case "initialize":
        return send({
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "lemonlime", version: "1" },
          },
        });
      case "tools/list":
        return send({ id: msg.id, result: { tools: [TOOL] } });
      case "tools/call":
        if (msg.params?.name !== "approve") return send({ id: msg.id, error: { code: -32602, message: "unknown tool" } });
        return send({ id: msg.id, result: await ask(url, token, msg.params.arguments) });
      case "ping":
        return send({ id: msg.id, result: {} });
      default:
        return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  });
}
