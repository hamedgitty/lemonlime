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
  --start-from <ref>       With --source-repo: start the new branch from this commit or
                           branch instead (forks keep the code they came from)
  --branch <name>          With --source-repo: work on this existing branch, not a new one
  --pull-request <n>       With --branch: it's pull request <n>'s branch (forks too)
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

The agent starts from the latest commit of `--base` (or `--start-from`); uncommitted
work on that branch is not copied in. If the repository has submodules, the new worktree
fills them (`git submodule update --init --recursive`); if that fails, the thread starts
anyway and says so. `lemonlime-runner cleanup` removes the worktree and the thread's
local history and keeps the branch, so nothing the agent committed is lost;
`lemonlime-runner git remove-worktree` removes only the worktree, and refuses when it has
uncommitted changes.

With `--branch <name>` the thread works on a branch that's already there (local, or
origin's), instead of making `agent/<thread>`. A branch can be checked out in only one
folder, so one that's checked out elsewhere (your own checkout included) is refused with
a message saying where. With `--pull-request <n>` as well, the runner looks the pull request
up with `gh` and makes its branch: from origin, or for a fork through a remote named after
the fork's owner, tracking the fork's branch so pushes go back to the pull request. When
the fork doesn't allow edits from maintainers, the thread says the agent can't push to it.
`lemonlime-runner git branches --repo <path>` and `git pull-request --repo <path> --ref
<link or #n>` print what the app's branch picker and pull request lookup show, as JSON.

Environment:

| Variable | Purpose |
| --- | --- |
| `LEMONLIME_THREAD_SECRET` | The thread's own secret. Client tokens must be signed with it. Required, unless `--secret-stdin` is given. Prefer `--secret-stdin`: see [Tokens](#tokens) for what the agent can read. |
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
  `turn_outcome_unknown`, then carries on with the queue. The apps show a Continue button
  on that error: `{"type":"continue_after_restart"}` sends a careful prompt that asks the
  agent to check whether a command already took effect before repeating it. It works at
  most 3 times in 5 minutes, so a runner that keeps crashing can't loop.

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

`GET /file-exists?path=<path>` answers with the file's path inside the working folder (or
404), so terminal output like `src/app.ts:12` can open the file. Absolute paths count only
when they point inside the folder.

`GET /file?path=<relative path>` (client token) returns one file from the working folder
for the app's file tabs, up to 20 MB. The path must be relative and stay inside the
working folder once symlinks are followed; `..`, absolute paths, `.git` and the runner's
own `.lemonlime` folder are refused.

`GET /folder?dir=<relative path>` (client token) lists one folder for the app's Files tab:
its sub-folders, then its files, each by name, up to 2,000 entries. It is built from the
same list as the composer's `@` menu, so files git ignores stay out.

The PTY comes from `@lydell/node-pty` (prebuilt, no compiler needed). The desktop app's
single-file runner can't hold a native module, so `build:sea` copies it next to the
executable and the app passes `LEMONLIME_NODE_PTY_DIR`.

## Project scripts

A project can keep a few named commands in `lemonlime.json` at its repository root. The
apps show them as buttons in the thread's panel and in the command palette (⌘K), and each
runs in its own panel terminal in the thread's folder:

```json
{
  "scripts": [
    { "name": "Setup", "command": "cp \"$LEMONLIME_PROJECT_ROOT/.env\" . && pnpm install", "runOnWorktreeCreate": true, "timeoutSeconds": 600 },
    { "name": "Dev", "command": "pnpm dev", "icon": "play", "previewUrl": "http://localhost:5173", "keybinding": "run-script-1" },
    { "name": "Test", "command": "pnpm test", "icon": "test" }
  ]
}
```

- `name` and `command` are required; `id` is made from the name when left out.
- `icon` is one of `play`, `test`, `lint`, `build`, `server`, `package`, `wrench`,
  `terminal`, `bug`, `rocket`, `database`, `sparkles`.
- `runOnWorktreeCreate`: run it once when a local thread's worktree is first made, before
  the agent starts (messages wait). Each has a time limit (`timeoutSeconds`, 10 minutes by
  default); a failure is shown with the end of its output, and the agent still starts.
- `previewUrl`: a local address opened in the panel's browser once the script starts.
- `keybinding`: `run-script-1` to `run-script-4`, the app's script shortcuts (⌘⌥1 to ⌘⌥4
  by default, changeable in Settings, Keyboard).

Every script and terminal gets `LEMONLIME_PROJECT_ROOT` (your own checkout for a local
thread, the thread's folder otherwise), `LEMONLIME_WORKTREE_PATH` and `LEMONLIME_THREAD_ID`.
The runner reads the file itself (`GET /project-scripts` lists what it found): the app only
ever names a script, so a script runs only where its file is. For a local thread that's
the file in your checkout; a cloud sandbox uses the copy in its own clone of the repository,
and setup scripts never run there.

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
answer has the compare page to open instead). `GET /git/pull-request/draft` writes a title
and description from the thread's first message and commits, without a model.
`GET /git/status` also says how many commits the branch is `behind` its base (origin's
copy when that's newer, fetched every few minutes), and `POST /git/update-from-base`
merges the base in, in the thread's own folder only: when it conflicts, the merge is
undone and the conflicting files are listed. `POST /git/pull-request/watch {on}` watches
the pull request every three minutes and sends the agent a message when its checks fail,
new comments arrive or it gets merge conflicts; comments alone wake it at most 10 times,
and it says once if no checks have shown up after 15 minutes. Only comments from people
who can push to the repository (owner, member or collaborator) or from the pull request's
author reach the agent; anyone else's are left out, and the thread says so once. The watch is saved, so it
carries on after a restart, and stops when the pull request is merged or closed. Diffs are capped at 400 files and 3 MB of
text; bigger files say they were shortened. Working-tree diffs use a scratch index, so
the agent's own index is never touched.

Every git call the runner makes turns off `core.fsmonitor`, hooks and bare-repository
discovery, refuses a remote whose address is a command (`ext::`), never runs an external
diff or textconv filter, has a time limit, and refuses branch names, refs and paths that
start with `-`. Settings people rely on still apply to those calls: credential helpers,
the ssh command, commit signing and content filters (large-file storage is one). The
agent can edit the repository's config, so a program named there for one of those still
runs when the runner commits, fetches or pushes.

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

The runner also finds dev servers on its own. While the agent works, and for a while after
a terminal is used, it checks every few seconds which TCP ports the processes it started
listen on (`ps` and `lsof`, on macOS and Linux; never on Windows), looking only at its own
process tree. Every process it starts carries `LEMONLIME_THREAD_ID`. A `listening_ports`
event lists what it found, the apps offer "Open localhost:<port>", and
`{"type":"offer_preview","port":N}` makes one of those ports a preview.

## Subagents

Agents get three MCP tools from `lemonlime-runner subagents-mcp` (Claude Code through
`--mcp-config`, Codex through `-c mcp_servers…`): `spawn_subagent`, `list_subagents` and
`message_subagent`. A subagent is another conversation with the same agent, in the same
working folder, given one task. Spawning is idempotent per `request_id`; an agent can have
3 working at once, and subagents can start their own once (2 levels). When a subagent
finishes, its reply is queued to whoever started it as a message, so the work goes on
with no app open; the thread shows `subagent_started` / `subagent_replied` notices.
A subagent works under the thread's current permission mode (checked again before each
of its turns; in plan mode it only looks), and what it has to ask about goes to the user
like the thread's own requests. Stopping the agent stops its subagents too: they keep
their conversation and can be messaged again, but nobody is sent a half-finished reply.
Only the agent that started a subagent can message it. The tools call the runner's
`/subagents` routes with a runner token signed with the agent key (see Tokens).

## Computer access (cloud threads)

In a sandbox, agents also get `computer_read_file`, `computer_list_dir` and
`computer_run_command` for the user's own computer. The runner forwards each request to
the newest connected desktop app that said it can answer (`hello.computer`), and the app
decides by the thread's setting: **Off** (the default), **Read-only**, **Ask first** (it
shows the exact request, with control, invisible and non-ASCII characters escaped so
look-alikes can't hide anything) or **Full**. Read-only still asks before a file that
usually holds keys or passwords (`~/.ssh`, `.env`, saved logins, shell history and the
like). Paths must be absolute, on this computer's own drives, and are never followed
through symbolic links; reads stop at 1 MB, commands at 60 seconds and 256 KB of output.
With no desktop app open, the agent is told the computer can't be reached.

The desktop app's native side, not its window, keeps each thread's setting (in
`~/.lemonlime/computer-access.json`) and checks it on every request; raising a thread's
setting and each question are confirmed in a native dialog. In that dialog "Don't allow"
is the button Return presses, and only a click on the allow button counts as a yes. One
question is on screen at a time, a request too long to read in full (over 2,000
characters) is refused rather than asked, and after a "no" the thread has to wait a few
seconds before it can ask again. A command runs in its own process group, which is
stopped when it ends or times out, so nothing it started is left running.

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

The agent is never handed the thread secret. The runner removes `LEMONLIME_THREAD_SECRET`
from the environment the agent and everything it starts inherit, and sets
`LEMONLIME_AGENT_KEY` instead: a key derived from the secret with `deriveAgentKey` that can't
be turned back into it. The agent's own tools (`lemonlime-runner preview`, the subagents and
computer tools, the git credential helper) sign with that key, and only those routes accept
it. Opening the thread as the user (`client` tokens) and talking to the control plane as the
runner still need the secret.

Whether the agent can go and find the secret depends on how the runner got it:

- **On stdin (`--secret-stdin`).** The secret is never in any process's environment or
  command line. This is how the desktop app starts local and SSH threads.
- **In `LEMONLIME_THREAD_SECRET`.** The runner drops the variable for everything it starts,
  but the operating system keeps the environment a process was started with, and another
  process of the same user can read it (`/proc/<pid>/environ` on Linux, `ps eww` on macOS).
  An agent that runs as the runner's user can therefore read the secret, and with it approve
  its own requests or act as the runner. Use this only where that is acceptable.
- **With a keeper (the sandbox providers' agent-user setting, see
  [sandboxes](sandboxes.md)).** A keeper running as root holds the secret and starts the
  runner and the agent as another user, so neither can read it. The runner asks the keeper to
  check tokens and to sign its own runner tokens. The agent runs as the same user as the
  runner, so it can ask the keeper for a runner token too; it still can't make a token that
  opens the thread as the user.

Without the agent-user setting, a sandbox's runner gets the secret in its environment, so the
second case applies to it.

## Idle pausing

The runner reports `idleSince` (when the agent last finished work) in every heartbeat.
The control plane pauses any cloud sandbox that has been idle for 5 minutes.
