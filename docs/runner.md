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
  --instructions-file <path>   Your own instructions, added to every turn (at most 32 KB)
  --strip-coauthors        Remove Co-authored-by trailers from the agent's commits
  --branch-prefix <prefix> Name the thread's branch <prefix><thread> (default: agent/)
  --retry-max-wait <min>   Retry turns that hit a busy provider or a usage limit (0: off)
  --disable-skills <names> Leave these bundled skills out (comma-separated)
  --no-command-guard       Turn the command guard off
  --exit-with-parent       Stop when the app that started it goes (with --secret-stdin, also
                           when stdin closes)
  --secret-stdin           Read the thread secret from the first line of stdin
  -v, --version            Print the runner's version
```

`lemonlime-runner --help` lists every option and environment variable. Cloud sandboxes
get the same settings through `LEMONLIME_INSTRUCTIONS`, `LEMONLIME_STRIP_COAUTHORS=1`,
`LEMONLIME_RETRY_MAX_WAIT` and `LEMONLIME_USER_SKILLS_<n>` (see "Workspace cloud
settings" in [self-hosting.md](self-hosting.md)).

### Your instructions

`--instructions-file` (or `LEMONLIME_INSTRUCTIONS`) adds your own instructions to every
turn: Claude Code gets them with `--append-system-prompt`, Codex as
`developer_instructions`, and OpenCode and other ACP agents, which have no system prompt,
at the start of each new conversation. Subagents and side chats get them too. More than
32 KB is cut short.

### Co-author trailers

With `--strip-coauthors`, commits the agent makes in the thread lose their
`Co-authored-by:` lines. The runner points the agent's git at a hooks folder of its own
(through `GIT_CONFIG_PARAMETERS`, so nothing in the repository changes); each hook there
runs the repository's own hook of the same name first, so project checks still run.

### Branch names

`--branch-prefix ai/` names a new thread's branch `ai/<thread>`. A thread keeps the branch
it started on (saved in its data folder), so changing the prefix never moves existing
threads. Cloud threads always use `agent/`.

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
| `LEMONLIME_THREAD_SECRET` | The thread's own secret. Client tokens must be signed with it. Required, unless `--secret-stdin` is given. |
| `LEMONLIME_HOME` | Where local worktrees and history live. Default `~/.lemonlime`. |

### Threads on your other machines (SSH)

The desktop app can run a thread on another computer of yours: a home server, a dev box,
or a machine on your Tailscale network (which is reachable over plain SSH). Add it under
Settings, Machines, by a host from your `~/.ssh/config` or as `user@host[:port]`, then pick
it in the place menu on the home screen and type the path of a git repository already on
that machine.

The app runs your own `ssh` with your own config, keys and agent, always in batch mode, so
it never asks for or stores a password or key. Starting a thread runs

```
ssh -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ControlPath=none ... \
    -L 127.0.0.1:<free local port>:127.0.0.1:<remote port> -- <host> \
    "exec lemonlime-runner --thread <id> --agent <kind> ... --secret-stdin --exit-with-parent \
     --host 127.0.0.1 --port <remote port> --source-repo <path>"
```

- The runner listens only on the remote machine's loopback; the app reaches it through the
  tunnel on this computer's loopback, and from there it is just like a local thread.
- The thread secret is sent as the first line of the session's stdin (`--secret-stdin`), so
  it never appears on a command line on either machine. The runner reads nothing else from
  stdin.
- With `--exit-with-parent`, the runner stops when stdin closes. Stopping the thread, quitting
  the app or a dropped connection all end the ssh session, and the runner there with it.
  After a drop the thread says it can't reach the machine, with a button to try again.
- The host can't start with `-` or hold spaces, and every word of the remote command is
  quoted for the remote shell (a POSIX shell such as sh, bash or zsh; a leading `~/` in a
  path means the remote home folder).
- Like local threads, the thread works in its own git worktree of that repository (under
  `~/.lemonlime/worktrees` there), and removing the thread cleans it up there.

The machine needs:

- SSH that works without a prompt: `ssh -o BatchMode=yes <host> true`. Connect once by hand
  first to accept its host key.
- Git, and the repository already cloned there.
- The agent's CLI installed and signed in there; agent accounts on this computer aren't used.
- The runner: a LemonLime checkout with Node 22 or newer (use
  `<checkout>/packages/runner/bin/lemonlime-runner.js` as the runner path), or the
  single-file runner built on a machine of the same kind with
  `pnpm --filter @lemonlime/runner build:sea`. Leave the runner path empty to use the
  `lemonlime-runner` on the PATH that SSH sees (often shorter than a login shell's).
  The Check button in Settings runs `ssh -o BatchMode=yes <host> lemonlime-runner --version`
  and says what's missing.

Things that only make sense on this computer stay off for threads elsewhere: opening the
folder in your editor, the local folder picker, switching agent accounts kept on this
computer, and computer access. Previews come through the runner's tunnel, like a cloud
sandbox's. Your instructions and thread settings go along as flags (instructions through
`LEMONLIME_INSTRUCTIONS`); your agent plugins stay on this computer.

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

Each thread can have up to 8 shells, at `/terminal` on the runner's port (same client
token as `/ws`; messages in `packages/protocol/src/terminal.ts`). The app names each one
in its hello (`terminal`, "main" when left out); a ninth is refused with a `limit` error,
and a `close` message ends a shell for good. Each runs in the thread's working folder on
the machine or sandbox where the agent runs, starts on first use and keeps running when
nobody is connected. Every app that opens a terminal sees the same shell. The runner
keeps the last 1 MB of output, so a client that reconnects gets only what it missed (or
the whole kept screen if that's gone). Input is capped at 64 KB per message, output is
sent in 64 KB pieces, and a client more than 4 MB behind for 10 seconds is dropped and
reconnects. The shell doesn't get the runner's thread secret or approval token.

`GET /file?path=<relative path>` (client token) returns one file from the working folder
for the app's file tabs, up to 20 MB. The path must be relative and stay inside the
working folder once symlinks are followed; `..`, absolute paths, `.git` and the runner's
own `.lemonlime` folder are refused.

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
levels and limits. `--model`, `--reasoning` and `--fast` set what the thread starts with
(`set_options` changes them later): Claude Code gets `--effort` and, for fast mode, a
`fastMode` setting; Codex `model_reasoning_effort` and the `fast` service tier. ACP agents
that offer a model setting (OpenCode does) are asked for the thread's model before each turn.

## Reviewing the branch

The apps read the thread's branch from git itself, over HTTP with the client token:
`GET /git/status` (changed files, commits, push state, the GitHub compare page, whether
the GitHub CLI is signed in), `GET /git/diff?scope=branch|uncommitted|commit` (per-file
status, line counts and hunks; `commit=<sha>` for one commit, `path=` and `context=` for
more lines around one file), `POST /git/push` (never forced) and `GET`/`POST
/git/pull-request` (opens one with `gh` when it's installed and signed in; otherwise the
answer has the compare page to open instead). Diffs are capped at 400 files and 3 MB of
text; bigger files say they were shortened. Working-tree diffs use a scratch index, so
the agent's own index is never touched.

Every git call the runner makes turns off `core.fsmonitor`, hooks and bare-repository
discovery, never runs an external diff or textconv filter, has a time limit, and refuses
branch names, refs and paths that start with `-`.

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

## Subagents

Agents get three MCP tools from `lemonlime-runner subagents-mcp` (Claude Code through
`--mcp-config`, Codex through `-c mcp_servers…`): `spawn_subagent`, `list_subagents` and
`message_subagent`. A subagent is another conversation with the same agent, in the same
working folder, given one task. Spawning is idempotent per `request_id`; an agent can have
3 working at once, and subagents can start their own once (2 levels). When a subagent
finishes, its reply is queued to whoever started it as a message, so the work goes on
with no app open; the thread shows `subagent_started` / `subagent_replied` notices.
Only the agent that started a subagent can message it. The tools call the runner's
`/subagents` routes with a runner token signed with the agent key (see Tokens).

## Computer access (cloud threads)

In a sandbox, agents also get `computer_read_file`, `computer_list_dir` and
`computer_run_command` for the user's own computer. The runner forwards each request to
the newest connected desktop app that said it can answer (`hello.computer`), and the app
decides by the thread's setting: **Off** (the default), **Read-only**, **Ask first** (it
shows the exact request, with control, invisible and non-ASCII characters escaped so
look-alikes can't hide anything) or **Full**. Paths must be absolute and are never
followed through symbolic links; reads stop at 1 MB, commands at 60 seconds and 256 KB of
output. With no desktop app open, the agent is told the computer can't be reached.

The desktop app's native side, not its window, keeps each thread's setting (in
`~/.lemonlime/computer-access.json`) and checks it on every request; raising a thread's
setting and each **Ask first** request are confirmed in a native dialog. A command runs in
its own process group, which is stopped when it ends or times out, so nothing it started is
left running.

## Moving a thread (teleport)

A thread can move between this computer and the cloud as one conversation. The desktop
app asks the source runner to pack it (`POST /teleport/export`): its own commits (from
where it left the base branch) as a git bundle, and its history, with a sha256 checksum.
It downloads both (`GET /teleport/<id>/bundle|history.json?offset=`), uploads them to the
target runner as attachments, and calls `POST /teleport/import`. The target checks the
checksum, refuses a branch that already has work of its own (nothing is overwritten),
needs the base commit to exist there (push the base branch first otherwise), applies
the commits, adds the history and gives the agent a recap. Importing the same transfer
twice does nothing. Afterwards the old copy is archived (and a cloud one paused).

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

### Automatic retry

`--retry-max-wait <minutes>` goes further: when a turn fails because the AI provider is
overloaded (529, 503, "overloaded", ...) or a usage limit is hit, the runner records a
`retry_scheduled` notice with `untilAt` and runs the same message again then, without a
new user message. It waits until the time the agent gave, or 30 s, 1, 2, 4, 8 and then
15 minutes when it didn't say, and never longer than the max wait in all for one message
(at most 12 tries). A limit that lifts after the max wait isn't retried
(`retry_given_up`). Sending a message or stopping the agent cancels the wait
(`retry_cancelled`). A waiting retry is saved, so it survives a runner restart; it needs
no client connected. With retry on, it replaces the "Continue where you left off" above.

## Safety guards

- **Commands.** With Claude Code, a pre-tool hook (`lemonlime-runner command-guard`) blocks
  the few commands that wreck a computer rather than a project: deleting `/`, system
  folders or the home folder, formatting or erasing disks, writing straight to disk
  devices, and fork bombs. The agent is told why and asked to leave it to you.
  OpenCode and other ACP agents get the same check when they ask permission to run a
  command: a dangerous one is refused at every autonomy level (`command_blocked` notice).
  `--no-command-guard` turns it off for a thread. Codex gets the same hook in cloud sandboxes,
  passed for each run with Codex's hook trust skipped (the sandbox is the agent's anyway); on
  your own computer it isn't added, since trusting hooks in your Codex config is your call.
- **Disk.** Below 15% free in the thread's folder (at most 10 GB) you get a warning; below
  5% (at most 2 GB) the agent is paused and new messages wait; at 8% (at most 4 GB) it
  carries on. If the disk is still full 30 seconds
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
(each skill is a folder with a `SKILL.md`), or leave ours out with `--no-bundled-skills`
(all of them) or `--disable-skills lemonlime-open-pr,lemonlime-previews` (some).
Skills in `~/.lemonlime/skills` (or `$LEMONLIME_HOME/skills`) are always copied too; the
desktop app's **Settings → Skills** adds and removes them there.

With `--plugins-dir <dir>` (the desktop app passes `~/.lemonlime/plugins`), the enabled
agent plugins listed in `<dir>/plugins.json` are added too: skills for every agent,
commands and subagents for Claude Code, MCP servers for Claude Code and Codex. Plugin
hooks are never run. See [Agent plugins](plugins.md).

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
generates locally. Tokens are short-lived HMAC-signed claims (`packages/protocol/src/token.ts`);
the runner refuses any that claim to live longer than 15 minutes. A thread or terminal
connection is closed (code 4001) when the token it opened with runs out; apps reconnect at
once with a fresh token, so removing someone from a workspace cuts them off within one
token's lifetime.

The agent never gets the thread secret. The runner removes `LEMONLIME_THREAD_SECRET` from
the environment the agent and everything it starts inherit, and sets `LEMONLIME_AGENT_KEY`
instead: a key derived from the secret with `deriveAgentKey` that can't be turned back into
it. The agent's own tools (`lemonlime-runner preview`, the subagents and computer tools, the
git credential helper) sign with that key, and only those routes accept it. Opening the
thread as the user (`client` tokens) and talking to the control plane as the runner still
need the secret, so an agent can't approve its own requests or post as the runner.

## Idle pausing

The runner reports `idleSince` (when the agent last finished work) in every heartbeat.
The control plane pauses any cloud sandbox that has been idle for 5 minutes.
