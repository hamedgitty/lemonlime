# Sandbox providers

`packages/sandbox` gives the control plane one interface, `SandboxProvider`, with
three implementations: `docker`, `daytona` and `e2b`. Pick one with
`LEMONLIME_SANDBOX_PROVIDER` (see `docs/self-hosting.md` for the full list of
settings).

```ts
import { createSandboxProvider } from "@lemonlime/sandbox";

// Node: pass process.env. Cloudflare Workers: pass the worker's `env` binding.
const provider = createSandboxProvider(process.env);
```

`createSandboxProvider` always takes the environment as an argument and throws
straight away, naming the variable, if a required setting is missing.

## Where it runs

The package only uses `fetch` and other web platform APIs, so the Daytona and
E2B providers work both on Node 22 and on Cloudflare Workers (with
`nodejs_compat`). There are no provider SDKs to install.

The Docker provider shells out to the `docker` CLI, so it needs Node and a
Docker daemon on the same machine. It loads `node:child_process` only when it is
first used, so importing the package is safe anywhere; on Workers its methods
throw an error saying to use `daytona` or `e2b` instead.

## Keeper mode: keeping the thread secret from the agent

The runner checks every connection against the thread secret. Started the plain way, the
runner gets that secret in its environment and the agent runs as the same user, so an agent
that looks for the secret can read it (see [Tokens](runner.md#tokens)). In keeper mode the
secret stays with a small process running as root, the keeper, and the runner and the agent
run as another user who can't read it.

| Provider | Setting | When it is unset |
| --- | --- | --- |
| docker | `LEMONLIME_DOCKER_AGENT_USER` | Keeper mode, as the user `agent` (the stock image has it) |
| daytona | `DAYTONA_AGENT_USER` | Off |
| e2b | `E2B_AGENT_USER` | Off |

On Docker, set `LEMONLIME_DOCKER_AGENT_USER` to another name if your image calls its user
something else, or to `none` to turn keeper mode off. Before it starts the first sandbox from
an image, the provider tries the keeper in a throwaway container with no network. If you
named a user and the image doesn't have it (or has no `lemonlime-runner` that can be a
keeper), creating a sandbox fails with an error that says what to set. If you named nothing
and the image can't do it, sandboxes start the plain way and one warning is logged.

Daytona (the sandbox is created with `user: "root"`) and E2B (envd starts the keeper as root)
start the runner through the keeper the same way once their setting names a user. Those two
haven't been tried on a real sandbox yet, so try one thread before turning it on for
everyone.

How it starts on Docker: the container runs as root with only `SETUID`, `SETGID` and `KILL`
added back (still `no-new-privileges`), and its command is `lemonlime-runner keeper --thread
<id> --agent-user agent -- sh -c <runner>`. The keeper takes the secret from its environment,
then starts the setup script and the runner as `agent` without it. The runner asks the keeper
over a local socket to check tokens and to sign its own short runner tokens.

What it protects:

- **The thread secret.** It is only in root's processes. The agent's user can't read their
  environment, memory or open files, and the secret is in no file. Without it nobody in the
  sandbox can make a token that opens the thread as you (a `client` token), so the agent
  can't approve its own requests or read the thread through the runner's port.
- **The keeper's socket.** It has a random name inside a folder with a random name that only
  root and the agent user's group can enter, and that nobody but root can list. Its address
  is not in the environment of the agent, of the terminal or of anything they start.

What it doesn't:

- **The runner from the agent.** They run as the same user. A process the agent starts can
  read the runner's files, including the thread's saved history, and can find the socket's
  address in the runner's own entry under `/proc`. It can then ask the keeper what the runner
  can ask: whether a token is good, and for a `runner` token that lasts at most ten minutes.
  With that token it can talk to the control plane as this thread's runner (send heartbeats
  and history, ask for the repository token the thread already uses). It can't reach another
  thread, and the keeper never signs a `client` token.
- **Anything from root.** Whoever can run `docker exec` or `docker inspect` on the host sees
  the secret, since it is in the container's settings. An agent that became root inside the
  sandbox could read the keeper; the dropped capabilities and `no-new-privileges` are what
  stand in the way.
- **What the agent is given on purpose**: your model account's sign-in, the repository token
  and the secrets you add to a thread are all in its reach, with or without a keeper.

## Lifecycle

| | docker | daytona | e2b |
| --- | --- | --- | --- |
| create | `docker run -d … sh -c <runner>` (in keeper mode, `… lemonlime-runner keeper … -- sh -c <runner>`) | create sandbox, wait until `started`, start the runner in a session | create sandbox, start the runner through envd |
| pause | `docker stop` | stop the sandbox and wait until `stopped` | pause (memory kept) |
| resume | `docker start` (re-runs the runner) | start, wait until `started`, start the runner again | connect (resumes), then ask the runner's `/healthz`; if it doesn't answer within a few seconds, start the runner again |
| destroy | `docker rm -f` | delete | kill |

Pausing or destroying a sandbox that is already paused or gone is not an error.
If `create` fails after the provider made a sandbox (for example it never
started, or the runner could not be launched), that sandbox is deleted again.

When a provider's API answers with an error, the error LemonLime reports keeps the status
code and a short piece of the answer with line breaks and control characters taken out, so
the reason shows up in logs without pages of markup. Pausing a Daytona sandbox that can't be
looked up fails with that error unless the answer was "not found", which means it is already
gone.

The runner's environment holds the thread secret and whatever keys the thread was given.
Docker sets it on the container and E2B hands it to the runner's own process only. Daytona's
request for starting a process has no place for an environment, so there it is set for the
whole sandbox, and every process Daytona starts in that sandbox gets it.

## Daytona

Settings: `DAYTONA_API_KEY` (required), `DAYTONA_API_URL` (default
`https://app.daytona.io/api`), and optionally `DAYTONA_SNAPSHOT_SMALL`,
`DAYTONA_SNAPSHOT_LARGE` or `DAYTONA_SNAPSHOT`, and `DAYTONA_AUTO_ARCHIVE_MINUTES`.

- A paused sandbox still pays Daytona for its disk until it is archived. By default
  that happens after a day; `DAYTONA_AUTO_ARCHIVE_MINUTES` makes it sooner (or later).
  Archived sandboxes cost nothing to keep but take longer to resume.

- Without `DAYTONA_SNAPSHOT`, each sandbox is built from
  `LEMONLIME_SANDBOX_IMAGE` with the CPU, memory and disk of its size. The image
  must be pullable by your Daytona organisation.
- With `DAYTONA_SNAPSHOT_SMALL` / `DAYTONA_SNAPSHOT_LARGE`, each size starts from
  its own snapshot of the same image, with that size's CPU, memory and disk. Make
  both with `DAYTONA_API_KEY=... node scripts/daytona-snapshots.mjs`, which prints
  the two names to set.
- With `DAYTONA_SNAPSHOT`, every size starts from that one snapshot and gets its
  resources. A size-specific snapshot wins when both are set.

Requests, all with `Authorization: Bearer <DAYTONA_API_KEY>`:

| Step | Request |
| --- | --- |
| create | `POST /sandbox` with `env`, `labels`, `public: true`, `autoStopInterval` (60 min safety net), `autoArchiveInterval` (24 h, or `DAYTONA_AUTO_ARCHIVE_MINUTES`), and either `buildInfo.dockerfileContent: "FROM <image>"` + `cpu`/`memory`/`disk` or `snapshot` |
| wait | `GET /sandbox/{id}` every second until `started` (2 minute limit; `error` or `build_failed` fail at once) |
| runner | `POST <toolbox>/process/session` `{ sessionId: "lemonlime-runner" }`, then `POST <toolbox>/process/session/lemonlime-runner/exec` `{ command, runAsync: true }` |
| runner URL | `GET /sandbox/{id}/ports/{port}/preview-url` |
| pause | `POST /sandbox/{id}/stop`, then poll until `stopped` |
| resume | `POST /sandbox/{id}/start`, poll, start the runner again |
| destroy | `DELETE /sandbox/{id}` |

`<toolbox>` is the sandbox's `toolboxProxyUrl` (or
`GET /sandbox/{id}/toolbox-proxy-url`) followed by `/<sandbox id>`.

## E2B

Settings: `E2B_API_KEY` (required), `E2B_TEMPLATE_SMALL` and
`E2B_TEMPLATE_LARGE` (templates built from `docker/sandbox.Dockerfile` with the
CPU and memory of each size).

Requests to `https://api.e2b.app`, all with `X-API-Key: <E2B_API_KEY>`:

| Step | Request |
| --- | --- |
| create | `POST /v2/sandboxes` `{ templateID, metadata, timeout, secure: true }` (timeout: 1 hour safety net; `secure` makes envd ask for the sandbox's access token) |
| get | `GET /sandboxes/{id}` |
| pause | `POST /sandboxes/{id}/pause` `{}` (keeps memory) |
| resume | `POST /v2/sandboxes/{id}/connect` `{ timeout }` |
| destroy | `DELETE /sandboxes/{id}` |

The runner is started through envd, the process agent inside every E2B
sandbox, at `https://49983-<id>.e2b.app/process.Process/Start`. This is a
Connect server-streaming call using the JSON codec
(`Content-Type: application/connect+json`, each message framed as one flag byte
plus a 4-byte length). The request runs
`/bin/bash -l -c <runner command>` with the runner's environment and the
sandbox's `envdAccessToken` in `X-Access-Token`. The provider waits for the
`start` event with the process id and then closes the stream; envd keeps the
process running, the same as the E2B SDK's background commands.

The runner URL is `https://<port>-<id>.e2b.app`.

## What can be reached from outside

The runner's own port is the only one LemonLime needs. Everything on it that reads or changes
the thread asks for a signed token: the thread and terminal WebSockets, the preview tunnel,
attachments and the full status. With no token, `/healthz` says only that the runner is up,
its thread id and its version. That is why the port can be public.

Other ports are another matter. Code in a sandbox can listen on any port it likes (a dev
server, a database), and who can reach those depends on the provider:

| Provider | The runner's port | Other ports the agent opens |
| --- | --- | --- |
| docker, with the compose file | Through the reverse proxy only, at `/sandbox/<container name>/…`, and only the runner's own paths | Not published and not forwarded. With the sandbox firewall on, not even other sandboxes or the host can reach them |
| docker, on its own | Published on `LEMONLIME_DOCKER_BIND_HOST` (default `127.0.0.1`, so this machine only) on a port Docker picks | Not published. Reachable from the Docker host and from other containers on the same Docker network |
| daytona | Public, at the port's preview address | Public too: sandboxes are created with `public: true`, so every port has a preview address that needs no sign-in. The address contains the sandbox id |
| e2b | Public, at `https://<port>-<id>.e2b.app` | Public too, at the same kind of address with their own port number |

So on Daytona and E2B, anyone who learns a sandbox's id can open whatever the agent is
serving there, for as long as it is running. The id is not a password: it appears in the
runner's address, which every app that opens the thread is given.

What you can do about it:

- Previews don't need a public port. The apps reach a dev server through the runner's
  tunnel, which connects to `127.0.0.1` inside the sandbox and checks a token, so a server
  that listens on `127.0.0.1` only still works in the preview pane. Say so in your
  instructions for agents or your setup script (many dev servers take `--host 127.0.0.1`),
  and keep databases on `127.0.0.1` too.
- Use the Docker provider behind the reverse proxy when nothing but the runner may be
  reachable.
- If your provider can ask for its own access token on a sandbox's ports, turning that on
  also closes the runner's port to the apps, which connect to it directly and can't send
  the provider's header. LemonLime doesn't set it for that reason.
- Don't put anything on a sandbox port that you wouldn't put on the internet behind an
  address that is hard to guess, and nothing more.

## Sandboxes that can't reach the control plane

Some providers only let sandboxes reach a list of well-known hosts (GitHub, package
registries, model providers) on their cheaper tiers, so the runner can't send heartbeats,
history or git token requests to your control plane. Set `LEMONLIME_RUNNER_RELAY=true` on
the control plane and runners start in relay mode instead: they keep those calls, and the
control plane collects them from the runner every minute (through the runner's public
port, with a token only the control plane and that sandbox can sign), makes them, and
hands back the answers. A new sandbox also starts with a first, hour-long repository
token, so its first clone doesn't wait.

On Node, `POST /api/cron/sweep` does the relaying too; on Cloudflare Workers the cron
trigger does. Expect up to a minute's delay on heartbeats and on refreshing git tokens.

## Checking a provider for real

With a provider's settings in the environment, this creates a small sandbox from the
image, waits for the runner's `/healthz`, pauses, resumes, checks again and destroys it
(it is destroyed even if a step fails or you stop the check):

```sh
LEMONLIME_SANDBOX_PROVIDER=daytona DAYTONA_API_KEY=... LEMONLIME_SANDBOX_IMAGE=ghcr.io/<owner>/lemonlime-sandbox:latest \
  pnpm --filter @lemonlime/sandbox live-check
```
