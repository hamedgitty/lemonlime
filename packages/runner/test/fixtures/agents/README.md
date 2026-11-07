# Recorded agent runs

Real output from each agent CLI, played back by `../replay-agent.mjs` in
`test/agent-fixtures.test.ts`. They guard the adapters against the CLIs as they
really behave, not as we assume they do.

| Agent | CLI version | Fixtures |
| --- | --- | --- |
| Claude Code | 2.1.302 | `fix-bug`, `not-logged-in` |
| Codex | 0.167.0 (`outdated-cli`: 0.145.0) | `fix-bug`, `not-logged-in`, `outdated-cli` |
| OpenCode (ACP) | 1.18.18 | `fix-bug` |

Each `fix-bug` run used the same tiny repo: `add.js` subtracts instead of adding and
`test.js` checks `add(2, 3) === 5`. Turn one asks the agent to fix it and run the test;
turn two asks which file it changed, which checks that the session carries over.
All were recorded at autonomy `edits` (the local default), through the real runner.

## Format

One JSON object per line. The first is `meta` (agent, CLI, version, date, note). Then:

- `argv`: the command the adapter ran (one per turn for one-shot CLIs)
- `in`: a line the runner wrote to the agent's stdin (ACP only)
- `out`: a line the agent printed on stdout
- `exit`: the exit code or signal

## Cleaning before commit

Fixtures are public, so recordings are cleaned first:

- the working folder becomes `/work` and home folders become `/home/user`
- stderr is dropped
- Claude Code's `init` line keeps only the session id, model, permission mode and
  version, and its `result` line keeps only status fields. Account usage in
  `rate_limit_event` is replaced with neutral values.
- OpenCode's command list (it lists the user's own skills) is dropped, and the model
  list is cut to the model in use

Check for names, emails, tokens and home paths before committing a new recording.

## Re-recording after a CLI upgrade

Run the agent through `ThreadRunner` with the agent command wrapped in a small
script that logs every stdin/stdout line in the format above. Clean the log as
described, replace the fixture, update the table, and fix the adapter until
`pnpm test` passes. When you run an agent from inside another agent's session, clear
that session's environment variables first (for Claude Code, `CLAUDE*` and
`ANTHROPIC_*`), or the nested CLI will not use your normal sign-in.
