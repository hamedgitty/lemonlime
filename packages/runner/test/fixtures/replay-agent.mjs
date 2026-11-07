#!/usr/bin/env node
// Plays back a recorded agent run from test/fixtures/agents so adapter tests use real
// CLI output. Usage: node replay-agent.mjs <fixture.jsonl> [the agent CLI's own args...]
//
// One-shot CLIs (Claude Code, Codex): picks the recorded turn whose arguments match the
// ones given exactly, prints its stdout lines and exits with its exit code. A mismatch
// exits 3, so a changed flag or a lost session id fails the test instead of passing quietly.
//
// ACP agents (OpenCode): reads JSON-RPC from stdin. For each request it finds the next
// recorded request with the same method, then plays back what the agent sent after it,
// with response ids rewritten to the live request's id.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [fixture, ...args] = process.argv.slice(2);
const rows = readFileSync(fixture, "utf8").trim().split("\n").map(l => JSON.parse(l));
const meta = rows.find(r => r.dir === "meta");
const out = line => process.stdout.write(line + "\n");

if (meta.cli.endsWith(" acp")) replayAcp();
else replayOneShot();

function replayOneShot() {
  const turns = [];
  for (const r of rows) {
    if (r.dir === "argv") turns.push({ argv: JSON.parse(r.line).slice(1), out: [], exit: 0 });
    else if (r.dir === "out") turns.at(-1).out.push(r.line);
    else if (r.dir === "exit") turns.at(-1).exit = JSON.parse(r.line).code ?? 1;
  }
  const turn = turns.find(t => JSON.stringify(t.argv) === JSON.stringify(args));
  if (!turn) {
    process.stderr.write(`replay-agent: no recorded turn has these args:\n${JSON.stringify(args)}\nrecorded:\n${turns.map(t => JSON.stringify(t.argv)).join("\n")}\n`);
    process.exit(3);
  }
  turn.out.forEach(out);
  process.exit(turn.exit);
}

function replayAcp() {
  // Recorded exchanges: each client message and the agent lines that followed it.
  const exchanges = [];
  for (const r of rows) {
    if (r.dir === "in") exchanges.push({ msg: JSON.parse(r.line), replies: [] });
    else if (r.dir === "out" && exchanges.length) exchanges.at(-1).replies.push(JSON.parse(r.line));
  }
  let next = 0;
  createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    const i = exchanges.findIndex((e, idx) => idx >= next && e.msg.method === msg.method);
    if (i < 0) {
      // Not in the recording (e.g. session/cancel): answer requests with an error, ignore notifications.
      if ("id" in msg) out(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `not recorded: ${msg.method}` } }));
      return;
    }
    next = i + 1;
    const recordedId = exchanges[i].msg.id;
    for (const reply of exchanges[i].replies) {
      const isOurResponse = "id" in reply && !("method" in reply) && reply.id === recordedId;
      out(JSON.stringify(isOurResponse ? { ...reply, id: msg.id } : reply));
    }
  });
}
