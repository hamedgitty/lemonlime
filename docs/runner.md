# Runner

The runner is a small Node daemon that runs next to exactly one coding agent —
inside a cloud sandbox, or on your own machine for local threads.

It:

- spawns the agent CLI and translates its output into LemonLime events,
- stores the thread's append-only event history on disk,
- serves a WebSocket so apps can watch and talk to the agent, resuming from any `seq`,
- keeps the agent's work on the thread's own git branch (`agent/<thread-id>`),
- optionally posts heartbeats to a control plane so idle sandboxes can be paused.

## Command line

```
lemonlime-runner --thread <id> --agent <kind> [options]
lemonlime-runner cleanup --thread <id> --source-repo <path>

  --thread <id>            Thread id (required)
  --agent <kind>           claude-code | codex | opencode | acp (required)
  --agent-command <cmd>    Command for ACP agents, e.g. "gemini --experimental-acp"
  --model <name>           Model to ask the agent for (optional)
  --workdir <path>         Repository working directory (default: ./workspace)
  --repo <url>             Clone this repository into --workdir if it is empty
  --source-repo <path>     Work in a separate git worktree of this local repository
                           (default location: ~/.lemonlime/worktrees/<repo>/<thread>)
  --base <branch>          Branch the agent branch starts from (default: main)
  --port <n>               Port to listen on (default: 7420, env LEMONLIME_RUNNER_PORT)
  --host <addr>            Interface to bind (default: 127.0.0.1; use 0.0.0.0 in sandboxes)
  --data-dir <path>        Where history is stored (default: <workdir>/.lemonlime, or
                           ~/.lemonlime/threads/<thread> with --source-repo)
  --control-plane <url>    Send heartbeats to this control plane
```

### Local threads and worktrees

With `--source-repo`, the runner never works in your own checkout. It adds a git
worktree for the thread's branch (`git worktree add`), so:

- your checked-out branch never changes,
- your uncommitted and untracked files are never touched,
- the agent's commits still show up in your repository on `agent/<thread-id>`.

The agent starts from the latest commit of `--base`; uncommitted work on that branch
is not copied in. `lemonlime-runner cleanup` removes the worktree and the thread's
local history and keeps the branch, so nothing the agent committed is lost.

Environment:

| Variable | Purpose |
| --- | --- |
| `LEMONLIME_THREAD_SECRET` | The thread's own secret. Client tokens must be signed with it. Required. |
| `LEMONLIME_HOME` | Where local worktrees and history live. Default `~/.lemonlime`. |

## Endpoints

- `GET /healthz` → `{ ok, threadId, status, latestSeq, idleSince }`
- `GET /ws` → WebSocket. First message must be `hello` with a `client` token.
  See `packages/protocol/src/wire.ts` for every message.

## Tokens

The control plane derives a per-thread secret with `deriveThreadSecret(master, threadId)`
and gives only that to the runner. The desktop app does the same with a secret it
generates locally. Tokens are short-lived HMAC-signed claims (`packages/protocol/src/token.ts`).

## Idle pausing

The runner reports `idleSince` (when the agent last finished work) in every heartbeat.
The control plane pauses any cloud sandbox that has been idle for 5 minutes.
