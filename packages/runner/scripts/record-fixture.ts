/**
 * Record a real agent run as a test fixture.
 *
 *   pnpm --filter @lemonlime/runner record <claude-code|codex|opencode> [name]
 *
 * Runs the standard "fix the bug" session (two turns, autonomy "edits") through the
 * real ThreadRunner with the agent CLI you have installed and signed in, cleans the
 * recording so it is safe to publish, and writes test/fixtures/agents/<agent>/<name>.jsonl.
 * Then update TESTED_AGENTS in src/agents/versions.ts, the sandbox Dockerfile and the
 * fixtures README, and run `pnpm test`.
 *
 * Set LEMONLIME_RECORD_ENV='{"CODEX_HOME":"/tmp/empty"}' to record failure cases.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { branchForThread, type Thread } from "@lemonlime/protocol";
import { adapterFor, detectVersion, TESTED_AGENTS, ThreadRunner, type TestedAgent } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const kind = process.argv[2] as TestedAgent;
const name = process.argv[3] ?? "fix-bug";
if (!kind || !(kind in TESTED_AGENTS)) {
  console.error(`usage: record-fixture <${Object.keys(TESTED_AGENTS).join("|")}> [name]`);
  process.exit(2);
}
const info = TESTED_AGENTS[kind];
const cliCommand = kind === "opencode" ? [info.binary, "acp"] : [info.binary];

export const PROMPTS = [
  "The test in test.js fails. Fix the bug in add.js, then run `node test.js` to check it passes. Keep your reply short.",
  "Which file did you change? Answer in one short sentence.",
];

function makeRepo(dir: string): void {
  writeFileSync(join(dir, "add.js"), "// Adds two numbers.\nexport function add(a, b) {\n  return a - b;\n}\n");
  writeFileSync(
    join(dir, "test.js"),
    'import { add } from "./add.js";\nif (add(2, 3) !== 5) {\n  console.error(`expected add(2, 3) to be 5, got ${add(2, 3)}`);\n  process.exit(1);\n}\nconsole.log("1 test passed");\n',
  );
  writeFileSync(join(dir, "package.json"), '{"name":"tiny","type":"module","private":true,"scripts":{"test":"node test.js"}}\n');
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...a], { cwd: dir });
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-qm", "init");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lemonlime-record-"));
  const work = join(root, "work");
  mkdirSync(work);
  makeRepo(work);
  const log = join(root, "raw.jsonl");
  const extraEnv = JSON.parse(process.env.LEMONLIME_RECORD_ENV ?? "{}") as Record<string, string>;
  Object.assign(process.env, extraEnv);

  const id = `record-${kind}`;
  const now = new Date().toISOString();
  const thread: Thread = {
    id,
    title: "",
    agent: { kind },
    repo: { url: work, baseBranch: "main" },
    branch: branchForThread(id),
    mode: "local",
    status: "provisioning",
    sandboxSize: "small",
    latestSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  const command = [process.execPath, join(here, "tee-agent.mjs"), log, ...cliCommand];
  const runner = new ThreadRunner({ thread, workdir: work, dataDir: join(root, "data"), adapter: adapterFor(kind), session: { autonomy: "edits", command } });
  await runner.init();
  // Nobody is watching a recording, so answer every approval request the way a user who
  // wants the standard session to work would: yes.
  const autoApprove = process.env.LEMONLIME_RECORD_DENY ? "deny" : "allow";
  runner.store.subscribe(e => {
    if (e.type === "approval_request") setTimeout(() => runner.answerApproval(e.requestId, autoApprove), 50);
  });
  for (const p of PROMPTS) {
    runner.sendMessage(p);
    await runner.settled();
    console.error(`[record] turn done`);
  }
  await runner.close();
  for (const e of runner.store.since(0)) console.error(JSON.stringify(e).slice(0, 200));

  const version = (await detectVersion(info.binary)) ?? "unknown";
  const rows = sanitize(readFileSync(log, "utf8"), {
    agent: kind,
    cli: cliCommand.join(" "),
    version,
    workdir: work,
    note: process.env.LEMONLIME_RECORD_NOTE ?? "",
  });
  const out = join(here, "..", "test", "fixtures", "agents", kind, `${name}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  rmSync(root, { recursive: true, force: true });
  console.error(`\nWrote ${out} (${rows.length} lines, ${info.binary} ${version}).`);
  console.error("Read it before committing: it will be public. Look for names, emails, tokens and home paths.");
}

const CLAUDE_INIT_KEYS = ["type", "subtype", "cwd", "session_id", "model", "permissionMode", "apiKeySource", "claude_code_version", "uuid"];
const CLAUDE_RESULT_KEYS = [
  "type",
  "subtype",
  "is_error",
  "result",
  "session_id",
  "duration_ms",
  "num_turns",
  "stop_reason",
  "terminal_reason",
  "total_cost_usd",
  "permission_denials",
  "uuid",
];
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));

/** Make a raw recording safe to publish. See test/fixtures/agents/README.md. */
export function sanitize(raw: string, meta: { agent: string; cli: string; version: string; workdir: string; note: string }) {
  const rows: Record<string, unknown>[] = [
    { dir: "meta", agent: meta.agent, cli: meta.cli, version: meta.version, recorded: new Date().toISOString().slice(0, 10), note: meta.note },
  ];
  const workdirs = [meta.workdir, meta.workdir.replace(/^\/private/, ""), `/private${meta.workdir}`];
  const scrub = (text: string) => {
    for (const w of workdirs) text = text.split(w).join("/work");
    return text.replace(/\/(Users|home)\/[^/"\\\s]+/g, "/home/user");
  };
  for (const raw_ of raw.split("\n")) {
    if (!raw_.trim()) continue;
    const r = JSON.parse(raw_) as { dir: string; line: string };
    let line = r.line;
    if (r.dir === "argv") {
      const argv = (JSON.parse(line) as string[]).map((a, i, all) => (all[i - 1] === "--mcp-config" ? "<mcp-config>" : a));
      argv.splice(0, 1, basename(argv[0]!));
      line = JSON.stringify(argv);
    } else if (r.dir === "in" || r.dir === "out") {
      let m = JSON.parse(line) as Record<string, unknown>;
      if (meta.agent === "claude-code") {
        if (m.type === "system" && m.subtype === "init") m = pick(m, CLAUDE_INIT_KEYS);
        else if (m.type === "result") m = pick(m, CLAUDE_RESULT_KEYS);
        else if (m.type === "rate_limit_event")
          m = { type: m.type, rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.1 }, session_id: m.session_id };
        for (const k of ["wire_ingest_context", "wire_tool_inputs", "thinking_display"]) delete m[k];
      }
      if (meta.agent === "opencode") {
        const update = (m.params as { update?: { sessionUpdate?: string } } | undefined)?.update;
        if (m.method === "session/update" && update?.sessionUpdate === "available_commands_update") continue; // the user's own commands and skills
        const result = m.result as { configOptions?: { options?: { value?: string }[]; currentValue?: string }[] } | undefined;
        for (const o of result?.configOptions ?? []) if (o.options) o.options = o.options.filter(x => x.value === o.currentValue);
      }
      line = JSON.stringify(m);
    }
    rows.push({ dir: r.dir, line: scrub(line) });
  }
  return rows;
}

const isEntry = process.argv[1]?.endsWith("record-fixture.ts");
if (isEntry) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
