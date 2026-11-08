// A tiny ACP agent for tests: newline-delimited JSON-RPC over stdio.
import { createInterface } from "node:readline";

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise(resolve => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
// FAKE_ACP_MODELS="a,b": offer a model setting (as OpenCode does) and say which model answered.
const models = process.env.FAKE_ACP_MODELS?.split(",") ?? [];
let model = models[0];

createInterface({ input: process.stdin }).on("line", async line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    return;
  }
  switch (msg.method) {
    case "initialize":
      return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    case "session/new":
      return send({
        id: msg.id,
        result: {
          sessionId: "sess-1",
          ...(models.length
            ? {
                configOptions: [
                  { id: "model", category: "model", type: "select", currentValue: model, options: models.map(value => ({ value, name: value })) },
                ],
              }
            : {}),
        },
      });
    case "session/set_config_option":
      if (msg.params.configId !== "model" || !models.includes(msg.params.value)) return send({ id: msg.id, error: { code: -32602, message: "unknown model" } });
      model = msg.params.value;
      return send({ id: msg.id, result: {} });
    case "session/prompt": {
      const sid = msg.params.sessionId;
      const text = msg.params.prompt[0].text;
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You said: " } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: models.length ? `${text} (model=${model})` : text } });
      const perm = await ask("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "t1", kind: "execute", title: "Run tests", rawInput: { command: process.env.FAKE_ACP_COMMAND ?? "npm test" } },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
      update(sid, {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: `permission=${perm.outcome.optionId}` } }],
      });
      // A closing message after the tool, e.g. a plan.
      if (process.env.FAKE_ACP_CLOSING) update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.FAKE_ACP_CLOSING } });
      return send({ id: msg.id, result: { stopReason: "end_turn" } });
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
