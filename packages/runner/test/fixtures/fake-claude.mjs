// Stands in for `claude -p --output-format stream-json`: reads the prompt on stdin and, like
// Claude Code, puts its AskUserQuestion and ExitPlanMode calls to the permission prompt tool
// (LemonLime's approval helper, started from the --mcp-config file). Writes its arguments to
// $ARGS_OUT. Prompts: "ask" asks a question, "plan" proposes a plan, anything else just replies.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
if (process.env.ARGS_OUT) writeFileSync(process.env.ARGS_OUT, JSON.stringify({ args, prompt }));
const out = msg => process.stdout.write(JSON.stringify({ session_id: "fake-session", ...msg }) + "\n");
const assistant = content =>
  out({ type: "assistant", message: { model: "fake-model", content, usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 40 } } });
const toolResult = (id, content, isError = false) =>
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const done = text => {
  out({ type: "result", subtype: "success", is_error: false, result: text, modelUsage: { "fake-model": { contextWindow: 200000 } } });
  process.exit(0);
};

/** Ask the permission prompt tool, the way Claude Code does. */
async function approve(tool, input, id) {
  const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
  const server = config.mcpServers.lemonlime;
  const helper = fileURLToPath(new URL("../../bin/approval-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [helper], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  createInterface({ input: child.stdout }).on("line", l => {
    const m = JSON.parse(l);
    replies.get(m.id)?.(m);
  });
  const call = (rid, method, params) =>
    new Promise(resolve => {
      replies.set(rid, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    });
  await call(1, "initialize", { protocolVersion: "2025-11-25" });
  const r = await call(2, "tools/call", { name: "approve", arguments: { tool_name: tool, input, tool_use_id: id } });
  child.kill();
  return JSON.parse(r.result.content[0].text);
}

if (prompt.startsWith("ask")) {
  const input = { questions: [{ question: "Which database?", header: "Database", options: [{ label: "SQLite" }, { label: "Postgres" }], multiSelect: false }] };
  assistant([{ type: "tool_use", id: "q1", name: "AskUserQuestion", input }]);
  const answer = await approve("AskUserQuestion", input, "q1");
  if (answer.behavior === "allow") {
    const got = Object.entries(answer.updatedInput.answers).map(([q, a]) => `"${q}"="${a}"`);
    toolResult("q1", `Your questions have been answered: ${got.join(", ")}.`);
    assistant([{ type: "text", text: `Going with ${Object.values(answer.updatedInput.answers)[0]}.` }]);
  } else {
    toolResult("q1", answer.message, true);
    assistant([{ type: "text", text: `No answer: ${answer.message}` }]);
  }
  done("ok");
} else if (prompt.startsWith("plan")) {
  const input = { plan: "# Plan\n\n1. Read the code\n2. Fix the bug" };
  assistant([{ type: "tool_use", id: "p1", name: "ExitPlanMode", input }]);
  const answer = await approve("ExitPlanMode", input, "p1");
  toolResult("p1", answer.message ?? "approved", answer.behavior !== "allow");
  assistant([{ type: "text", text: "Waiting for your go-ahead." }]);
  done("ok");
} else {
  assistant([{ type: "text", text: `You said: ${prompt}` }]);
  done("ok");
}
