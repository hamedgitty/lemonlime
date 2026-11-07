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

The tested versions live in `TESTED_AGENTS` (`src/agents/versions.ts`). The sandbox
image installs exactly those, and `test/versions.test.ts` fails if the fixtures, the
Dockerfile or this README disagree with it. To move an agent to a new version:

1. Update the CLI on your machine and make sure it is signed in.
2. Record the standard session: `pnpm --filter @lemonlime/runner record codex`
   (or `claude-code`, `opencode`). It runs the two prompts through the real runner,
   cleans the recording and writes `<agent>/fix-bug.jsonl`. For failure cases, pass a
   name and point the CLI at an empty config folder, e.g.
   `LEMONLIME_RECORD_ENV='{"CODEX_HOME":"/tmp/empty"}' pnpm --filter @lemonlime/runner record codex not-logged-in`.
3. Read the new file before committing: it will be public.
4. Bump the version in `TESTED_AGENTS`, the sandbox Dockerfile and the table above.
5. Run `pnpm test` and fix the adapter until it passes.

The runner checks the installed CLI's version when a thread starts. If it is older
than the tested one, the thread shows a note with the command that updates it.
