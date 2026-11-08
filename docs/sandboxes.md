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

With `LEMONLIME_DOCKER_AGENT_USER=agent`, the agent runs as its own user, apart from the
thread secret. The container starts as root with only `SETUID`, `SETGID` and `KILL` added
back (still `no-new-privileges`), and runs `lemonlime-runner keeper --thread <id>
--agent-user agent -- sh -c <runner>`: the keeper keeps the secret, then starts the setup
script and the runner as `agent` without it. The runner asks the keeper over a local socket
to check tokens and to sign its own short runner tokens; the keeper never signs a token for
the user's apps. As root, the keeper's memory and environment are out of the agent's reach,
and so is the secret. Daytona and E2B don't use this yet.

## Lifecycle

| | docker | daytona | e2b |
| --- | --- | --- | --- |
| create | `docker run -d … sh -c <runner>` | create sandbox, wait until `started`, start the runner in a session | create sandbox, start the runner through envd |
| pause | `docker stop` | stop the sandbox and wait until `stopped` | pause (memory kept) |
| resume | `docker start` (re-runs the runner) | start, wait until `started`, start the runner again | connect (resumes; the runner is still running) |
| destroy | `docker rm -f` | delete | kill |

Pausing or destroying a sandbox that is already paused or gone is not an error.
If `create` fails after the provider made a sandbox (for example it never
started, or the runner could not be launched), that sandbox is deleted again.

## Daytona

Settings: `DAYTONA_API_KEY` (required), `DAYTONA_API_URL` (default
`https://app.daytona.io/api`), and optionally `DAYTONA_SNAPSHOT_SMALL`,
`DAYTONA_SNAPSHOT_LARGE` or `DAYTONA_SNAPSHOT`.

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
| create | `POST /sandbox` with `env`, `labels`, `public: true`, `autoStopInterval` (60 min safety net), `autoArchiveInterval` (24 h), and either `buildInfo.dockerfileContent: "FROM <image>"` + `cpu`/`memory`/`disk` or `snapshot` |
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
| create | `POST /v2/sandboxes` `{ templateID, metadata, envVars, timeout }` (timeout: 1 hour safety net) |
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
(it is destroyed even if a step fails):

```sh
LEMONLIME_SANDBOX_PROVIDER=daytona DAYTONA_API_KEY=... LEMONLIME_SANDBOX_IMAGE=ghcr.io/<owner>/lemonlime-sandbox:latest \
  pnpm --filter @lemonlime/sandbox live-check
```
