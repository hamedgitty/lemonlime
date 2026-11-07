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

## Messages, queueing and retries

- A message sent while the agent is working joins a queue instead of failing. The
  runner sends a `queue_update` event with the whole queue whenever it changes, and
  starts queued messages in order once the agent is free. Interrupting stops only the
  current turn.
- `send_message.clientMsgId` is a request id. The runner remembers every id it has
  accepted (in history and in the saved queue), so sending the same id again is
  acknowledged as a `duplicate` and never starts a second turn. `RunnerClient` resends
  unacknowledged messages after a reconnect for this reason.
- Every `send_message` gets an `ack` with `started`, `queued` or `duplicate`.
- If the runner stops in the middle of a turn, it never runs that message again. On
  restart it commits whatever the agent left behind, records an error with code
  `turn_outcome_unknown`, then carries on with the queue.

## Terminal

Each thread has one shell, at `/terminal` on the runner's port (same client token as
`/ws`; messages in `packages/protocol/src/terminal.ts`). It runs in the thread's working
folder on the machine or sandbox where the agent runs, starts on first use and keeps
running when nobody is connected. Every app that opens it sees the same shell. The runner
keeps the last 1 MB of output, so a client that reconnects gets only what it missed (or
the whole kept screen if that's gone). Input is capped at 64 KB per message, output is
sent in 64 KB pieces, and a client more than 4 MB behind for 10 seconds is dropped and
reconnects. The shell doesn't get the runner's thread secret or approval token.

The PTY comes from `@lydell/node-pty` (prebuilt, no compiler needed). The desktop app's
single-file runner can't hold a native module, so `build:sea` copies it next to the
executable and the app passes `LEMONLIME_NODE_PTY_DIR`.

## Going back (rewind) and compacting

Every user message records the commit the thread's branch was on when its turn began.
`{"type":"rewind","toSeq":N,"restoreFiles":bool}` goes back to the message at seq N: the
agent stops, waiting messages are dropped, and the agent starts a fresh conversation that
gets a recap of everything said before N. With `restoreFiles` the branch is reset to that
commit; what was there is kept at `refs/lemonlime/rewind/<time>`, and the next push
replaces the remote branch. History is never deleted: a `rewind` event marks what apps
leave out (`withoutRewound` in the protocol). `{"type":"compact"}` asks Claude Code to
shrink its conversation (`/compact`); other agents say they can't.

## Attachments, models and thinking

Files go to the runner over HTTP with the client token: `POST /attachments` {id, name,
size} starts an upload, `PUT /attachments/<id>?offset=N` sends the next piece (up to
4 MB), and `GET /attachments/<id>` says how much arrived, so a dropped connection resumes
where it stopped. Images can be up to 10 MB and other files up to 100 MB. Finished files
sit in `.lemonlime-attachments/` in the thread's folder (kept out of git), and a
`send_message` with their ids tells the agent where they are.

`GET /capabilities` lists the agent's models (Codex's own list when it has one), thinking
levels and limits. `--model` and `--reasoning` are fixed when the thread starts: Claude
Code gets a thinking budget (`MAX_THINKING_TOKENS`), Codex `model_reasoning_effort`.

## Previews

When the agent starts a dev server it runs `lemonlime-runner preview <port> --name <what>`
(the bundled `lemonlime-previews` skill tells it to), which signs a runner token with the
thread's secret and offers the port; a `preview_update` event lists what's on offer. On
this computer the apps open `http://localhost:<port>` directly. For a cloud thread the
desktop app runs the runner in `tunnel` mode: it listens on 127.0.0.1 only, refuses
requests whose Host or Origin isn't that address (so other sites can't reach it through
DNS rebinding), and carries each connection to the sandbox over the runner's `/tunnel`
socket, which takes a client token and only offered ports. HTTP, WebSockets and
server-sent events all pass through as bytes; there is no public URL.

## Side chats

`side_ask` (with no `sideId`) starts a side chat: a separate agent conversation, at the
read-only autonomy level, that gets a recap of the thread and the question. It can read
files but not change them (Claude Code: editing tools off and nothing else allowed;
Codex: its read-only sandbox; ACP: only read, search and fetch). Its messages come back
as `side_event`s and never enter the thread's history. Unpinned chats are discarded on
`side_close` or when the runner stops; `side_pin` keeps one in the thread's data folder.

## Usage limits

When an agent stops because the user's plan limit is reached (Claude says when it
resets; others usually print a time or "try again in …"), the thread gets a
`usage_limited` notice with `untilAt`, and the runner sends "Continue where you left
off" for the user once the limit lifts, or straight away when they sign in again. Without
a reset time it tries again after 30 minutes. It does this at most 3 times a day per
thread, and not at all once the user writes something themselves.

## Safety guards

- **Commands.** With Claude Code, a pre-tool hook (`lemonlime-runner command-guard`) blocks
  the few commands that wreck a computer rather than a project: deleting `/`, system
  folders or the home folder, formatting or erasing disks, writing straight to disk
  devices, and fork bombs. The agent is told why and asked to leave it to you.
  `--no-command-guard` turns it off for a thread. Other agents don't offer a hook yet.
- **Disk.** Below 15% free in the thread's folder you get a warning; below 5% the agent is
  paused and new messages wait; at 8% it carries on. If the disk is still full 30 seconds
  after pausing, the program that wrote the most is closed (Linux).
- **Out of memory (Linux).** Everything the agent starts gets a higher out-of-memory score
  than the agent and the runner, so a runaway build is what the system stops.

## Memory on your computer

Local threads share your computer, so the runner watches the memory used by everything
the agent starts (the agent, builds, dev servers). Past half the computer's memory it
stops the agent's turn and says why in the thread; if the programs left behind are still
over at the next check, it closes the biggest one. `--memory-limit-mb` sets a different
limit. Cloud sandboxes have their own fixed memory instead.

## Skills

Every thread gets LemonLime's bundled skills (`packages/runner/skills`), copied to where
its agent looks: `.claude/skills` for Claude Code, `.agents/skills` for Codex, OpenCode
and other ACP agents. They cover git hygiene, running tests first, opening a pull
request, and when to stop and ask. The copies are listed in the repository's local
`.git/info/exclude`, so they are never committed. Add your own with `--skills <dir>`
(each skill is a folder with a `SKILL.md`), or leave ours out with `--no-bundled-skills`.
Skills in `~/.lemonlime/skills` (or `$LEMONLIME_HOME/skills`) are always copied too; the
desktop app's **Settings → Skills** adds and removes them there.

## Approvals

At autonomy `edits` (the default for local threads) agents edit files freely but ask
before anything else, most importantly before running a command. The runner turns
each question into an `approval_request` event; the app shows the exact command with
Allow / Don't allow, and answers with an `approve` message. The decision is recorded
as `approval_result` (`by`: `user`, `timeout` after 30 minutes, `interrupted` when the
turn is stopped, or `expired` when the runner restarted before anyone answered).
Anything not answered is declined.

- **Claude Code** runs in print mode, where nobody can answer its prompts, so the
  runner gives it a small MCP tool (`bin/approval-mcp.mjs`, passed with
  `--permission-prompt-tool`). The tool reaches the runner through a private
  127.0.0.1 endpoint guarded by a random token.
- **ACP agents** (OpenCode and others) ask with `session/request_permission`. Reads,
  searches and edits are allowed straight away; everything else is asked.
- **Codex** runs commands inside its own OS sandbox (`workspace-write`), so it doesn't
  ask.

At autonomy `full` (cloud sandboxes) nothing is asked.

## Signing agents in (cloud sandboxes)

An app sends `start_login`; the runner starts the agent's own sign-in inside the sandbox
(`claude setup-token` for Claude Code, device sign-in for Codex) with no browser, and
reports progress as `login` messages: a link to open, a code to type there, or a request
to paste back the code the page shows (`login_input`). These messages go to connected
apps only and never enter the thread's history. On success the runner uses the
credential straight away, removes its value from every event, and uploads it to the
control plane, which keeps it encrypted for the user's next sandboxes.

## Safety limits

- **Huge output.** A single line from an agent over 16 MB is dropped without being
  buffered, and the history says so (`notice` with code `output_too_large`). Tool
  input and output over 256 KB, and agent messages over 512 KB, keep their start and
  note how much was left out.
- **Quiet agents.** After 15 minutes with no output, the runner adds a `notice`
  (`agent_quiet`). It doesn't stop the agent, since long builds are often silent.
- **Runaway turns.** A turn is stopped after 4 hours (`turn_timeout`). Its changes
  are kept.
- **Crashes.** If the agent is killed from outside (out of memory, a signal), the
  runner restarts it once and continues the same conversation (`agent_restarted`).
  If it crashes again straight away, the runner stops restarting it and reports
  `process_lost`; the next message starts it fresh.
- **Sign-in and updates.** `auth_required` and `agent_outdated` errors carry the
  agent's own words plus the command that fixes it, such as `claude auth login` or
  `codex update`.

## Tokens

The control plane derives a per-thread secret with `deriveThreadSecret(master, threadId)`
and gives only that to the runner. The desktop app does the same with a secret it
generates locally. Tokens are short-lived HMAC-signed claims (`packages/protocol/src/token.ts`).

## Idle pausing

The runner reports `idleSince` (when the agent last finished work) in every heartbeat.
The control plane pauses any cloud sandbox that has been idle for 5 minutes.
