#!/usr/bin/env node
// A tiny MCP server (stdio, JSON-RPC) with one tool, `approve`, that Claude Code calls
// through --permission-prompt-tool whenever it needs permission. It forwards the
// question to the LemonLime runner and returns the user's answer. No dependencies.
//
// Env: LEMONLIME_APPROVAL_URL, LEMONLIME_APPROVAL_TOKEN (set by the runner).
import { createInterface } from "node:readline";

const url = process.env.LEMONLIME_APPROVAL_URL;
const token = process.env.LEMONLIME_APPROVAL_TOKEN;
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

const TOOL = {
  name: "approve",
  description: "Ask the LemonLime user whether the agent may use a tool.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

function summarize(tool, input) {
  if (input && typeof input === "object") {
    for (const key of ["command", "file_path", "path", "url", "pattern"]) if (typeof input[key] === "string" && input[key].trim()) return input[key];
  }
  return tool;
}

async function ask(args) {
  const tool = String(args?.tool_name ?? "tool");
  const input = args?.input ?? {};
  let decision = "deny";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool, input, summary: summarize(tool, input) }),
    });
    if (res.ok) decision = (await res.json()).decision === "allow" ? "allow" : "deny";
  } catch {
    decision = "deny";
  }
  const answer =
    decision === "allow"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user did not allow this. Ask them, or try another way." };
  return { content: [{ type: "text", text: JSON.stringify(answer) }] };
}

createInterface({ input: process.stdin }).on("line", async line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!("id" in msg)) return; // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lemonlime", version: "1" } },
      });
    case "tools/list":
      return send({ id: msg.id, result: { tools: [TOOL] } });
    case "tools/call":
      if (msg.params?.name !== "approve") return send({ id: msg.id, error: { code: -32602, message: "unknown tool" } });
      return send({ id: msg.id, result: await ask(msg.params.arguments) });
    case "ping":
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
