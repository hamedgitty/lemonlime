# Self-hosting the control plane

The control plane (`apps/web`) is a Next.js app. It signs people in, keeps the
list of threads, starts, pauses and resumes cloud sandboxes, and issues the
short-lived tokens that apps use to talk to a thread's runner. It never sees
the live conversation: apps connect to the runner directly over WebSocket.

```
browser / desktop ──(WebSocket + client token)──▶ runner (in the sandbox)
        │                                             │
        └──(HTTPS)──▶ control plane ◀──── heartbeats ─┘
                          │
                          ├──▶ SQLite: Cloudflare D1, or a local file
                          └──▶ SandboxProvider: docker | daytona | e2b
```

It runs in one of two ways (plus a ready-made Docker Compose setup of B, section C):

| | **A. Cloudflare Workers + D1** | **B. Any Node server + SQLite file** |
| --- | --- | --- |
| Build | `pnpm --filter @lemonlime/web cf:build` (OpenNext) | `pnpm --filter @lemonlime/web build` |
| Database | D1 binding `DB` | `LEMONLIME_DATABASE_URL` (default `file:./data/lemonlime.db`) |
| Idle sweep | Worker cron trigger, every minute | Your scheduler calls `POST /api/cron/sweep` every minute |
| Sandbox providers | `daytona`, `e2b` | `docker`, `daytona`, `e2b` |
| Sign-in email | Cloudflare Email Service binding `EMAIL`, or Resend | Resend (or the console, in development) |

Both need Node 22+ and pnpm 11 to build, and one sandbox provider for cloud
threads. Local threads (agents on your own computer, driven by the desktop app)
only need the control plane for sign-in and the thread list.

## Settings

Copy `.env.example` from the repository root and fill it in. On Node, Next.js
reads `apps/web/.env.local`. On Workers, plain settings go under `vars` in
`apps/web/wrangler.jsonc` and secrets are set with `wrangler secret put`; for
`wrangler dev`, put them in `apps/web/.dev.vars`.

| Variable | Required | Notes |
| --- | --- | --- |
| `LEMONLIME_PUBLIC_URL` | yes | Public URL of the control plane. Better Auth uses it as its base URL and trusted origin; runners send heartbeats to `<url>/api/runner/heartbeat`, so sandboxes must be able to reach it. |
| `BETTER_AUTH_SECRET` | yes (secret) | Signs session cookies. `openssl rand -base64 32`. Changing it signs everyone out. |
| `LEMONLIME_TOKEN_SECRET` | yes (secret) | Master secret, at least 16 characters (`openssl rand -hex 32`). Each thread's secret is derived from it. Changing it invalidates every running sandbox's tokens. |
| `LEMONLIME_CRON_SECRET` | Node | Bearer secret for `POST /api/cron/sweep`. Not needed on Workers. |
| `LEMONLIME_DATABASE_URL` | no | Node only. libSQL URL of the SQLite database, default `file:./data/lemonlime.db` (relative to `apps/web`). |
| `LEMONLIME_EMAIL_FROM` | yes | Sender of sign-in codes, e.g. `LemonLime <sign-in@example.com>`. |
| `RESEND_API_KEY` | no (secret) | Send email through Resend when there is no `EMAIL` binding. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | no | Both set → "Continue with GitHub" on the sign-in page. |
| `LEMONLIME_SANDBOX_PROVIDER` | yes | `docker`, `daytona` or `e2b`. |
| `LEMONLIME_SANDBOX_IMAGE` | yes | Image with the runner and agent CLIs (see below). |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL` | daytona | `DAYTONA_API_KEY` is a secret. |
| `E2B_API_KEY`, `E2B_TEMPLATE_SMALL`, `E2B_TEMPLATE_LARGE` | e2b | `E2B_API_KEY` is a secret. |

The app builds without any of these set; missing values only fail the requests
that need them, with a message naming the variable.

## Signing in

People sign in with a **one-time code**: they enter their email, receive a
6-digit code (valid for 10 minutes) and type it in. The first sign-in creates
the account and a personal workspace. Codes are stored hashed and a code stops
working after 5 wrong attempts.

Rate limits are counted in the database (table `rate_limit`), so they hold across
every Worker isolate or Node process:

| What | Limit |
| --- | --- |
| Any sign-in request, per client IP | 100 a minute |
| Asking for a code, per client IP | 3 a minute |
| Entering a code, per client IP | 10 a minute |
| Codes emailed to one address, whatever the IP | 5 an hour (extra requests send nothing, and look the same) |
| New personal access tokens, per user | 10 an hour |
| New threads, and sandbox starts/resumes, per user | 30 a minute each |

On Node, the client IP comes from `X-Forwarded-For`; make sure your proxy overwrites
that header rather than passing on whatever the client sent.

Email is sent with the first transport that is configured:

1. **Cloudflare Email Service** — a `send_email` binding named `EMAIL` (Workers
   only). The domain of `LEMONLIME_EMAIL_FROM` must be onboarded:
   `npx wrangler email sending enable example.com`.
2. **Resend** — `RESEND_API_KEY`, with the sender's domain verified in Resend.
3. **Console** — in development only (`next dev`, or `NODE_ENV=development` in
   `.dev.vars`), codes are printed to the server log. In production, asking for
   a code fails with a message telling the person the server cannot send email.

GitHub sign-in (optional): create a GitHub OAuth app with the callback URL
`<LEMONLIME_PUBLIC_URL>/api/auth/callback/github` and set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`.

## A. Cloudflare Workers + D1

`apps/web/wrangler.jsonc` describes the Worker: the D1 binding `DB`, the
`EMAIL` binding, a cron trigger that runs the idle sweep every minute, and the
non-secret settings. `apps/web/worker.ts` is the entry point: it wraps the
handler OpenNext generates and adds the scheduled sweep.

```sh
pnpm install
cd apps/web

# 1. Create the database and paste its id into wrangler.jsonc (d1_databases[0].database_id).
npx wrangler d1 create lemonlime
npx wrangler r2 bucket create lemonlime-history   # thread history (binding HISTORY)

# 2. Apply the schema (packages/db/migrations).
pnpm db:migrate:remote

# 3. Set secrets.
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put LEMONLIME_TOKEN_SECRET
npx wrangler secret put DAYTONA_API_KEY        # or E2B_API_KEY
# optional: RESEND_API_KEY, GITHUB_CLIENT_SECRET

# 4. Edit "vars" in wrangler.jsonc: LEMONLIME_PUBLIC_URL, LEMONLIME_EMAIL_FROM,
#    LEMONLIME_SANDBOX_PROVIDER (daytona or e2b), LEMONLIME_SANDBOX_IMAGE, GITHUB_CLIENT_ID.
#    Remove the "send_email" block if you send through Resend instead.

# 5. Build with OpenNext and deploy.
pnpm cf:deploy
```

The `docker` sandbox provider does not work on Workers (there is no Docker
daemon to talk to); use `daytona` or `e2b`.

### Running the Workers build locally

```sh
cd apps/web
cp ../../.env.example .dev.vars      # then fill in; add NODE_ENV=development to log sign-in codes
pnpm db:migrate:local                # local D1 under .wrangler/
pnpm cf:preview                      # OpenNext build + wrangler dev on http://localhost:8787
```

Set `LEMONLIME_PUBLIC_URL=http://localhost:8787` in `.dev.vars`. Under
`wrangler dev` the `EMAIL` binding does not send anything; it prints the
message and writes it under `.wrangler/tmp/email/`. Trigger the sweep with
`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`
(start with `npx wrangler dev --test-scheduled`).

`pnpm cf:typegen` writes `cloudflare-env.d.ts` (git-ignored) with the Worker's
binding and runtime types, if you want them while working on Worker-only code.

## B. Any Node server with a SQLite file

```sh
pnpm install
cp .env.example apps/web/.env.local      # then fill in
pnpm --filter @lemonlime/web build
pnpm --filter @lemonlime/web start       # next start; or: pnpm dev:web during development
```

The database file is created and migrated on first use (the same migrations
as D1, tracked in the same `d1_migrations` table). Back it up like any SQLite
file. Run a single instance per database file.

Long-running requests: creating or resuming a sandbox waits for the provider,
which can take tens of seconds, so allow at least 2 minutes per request if your
host has a timeout. Put the app behind a reverse proxy that sets
`X-Forwarded-For`, so sign-in rate limits apply per client.

### Scheduling the sweep

`POST /api/cron/sweep` pauses:

- every running cloud sandbox whose agent has been idle for 5 minutes
  (`IDLE_PAUSE_AFTER_MS`, end reason `idle`),
- every running sandbox whose runner has stopped sending heartbeats for
  10 minutes, or that reports a failure (end reason `error`),
- every running sandbox the usage policy no longer allows
  (`UsagePolicy.canKeepRunning`, end reason `policy`).

It is idempotent: a sandbox's run is recorded once, however often the sweep runs
or however many sweeps overlap. Call it **every minute** from any scheduler, with
the cron secret:

```sh
curl -fsS -X POST -H "Authorization: Bearer $LEMONLIME_CRON_SECRET" \
  https://your-control-plane.example.com/api/cron/sweep
```

For example, a crontab entry:

```
* * * * * curl -fsS -X POST -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-control-plane.example.com/api/cron/sweep >/dev/null
```

A systemd timer or a Kubernetes CronJob works just as well. The response lists
what was checked and paused. (On Workers the cron trigger runs the same sweep
directly; you do not need this route there.)

## C. Docker Compose on one server

`compose.yaml` runs everything on one machine: the dashboard on Node with a SQLite
file, [Caddy](https://caddyserver.com) in front of it with automatic HTTPS, the idle
sweep once a minute, and every cloud thread as a Docker container on the same host.

On a fresh **Ubuntu 24.04** server, point a domain at it and run:

```bash
curl -fsSL https://raw.githubusercontent.com/hamedgitty/lemonlime/main/scripts/install-ubuntu.sh -o install.sh
less install.sh                                      # read it first
sudo bash install.sh lemonlime.example.com sign-in@example.com
```

The script installs Docker, puts LemonLime in `/opt/lemonlime`, writes `.env` with
freshly generated secrets, builds the images and starts everything. Then add a
`RESEND_API_KEY` to `/opt/lemonlime/.env` so sign-in codes can be emailed, and run
`docker compose up -d` again. Running the script again updates the code and keeps your
`.env` and data.

By hand, on any machine with Docker:

```bash
cp .env.example .env          # fill in the secrets; set LEMONLIME_PUBLIC_URL and
                              # LEMONLIME_SITE_ADDRESS (your domain, or :80 for plain HTTP)
docker compose --profile build build
docker compose up -d
```

How runners are reached: each sandbox joins the `lemonlime-sandboxes` network and opens
no port on the host. Caddy forwards `/sandbox/lemonlime-<thread id>/…` to that
container's runner, so apps talk to runners over the same HTTPS address as the
dashboard, and only those containers on the runner port can be reached. Runners send
heartbeats to the dashboard over the internal network (`LEMONLIME_RUNNER_CONTROL_PLANE_URL`).

The dashboard container has the host's Docker socket so it can start sandboxes, which
gives it full control of Docker on the host: use a machine dedicated to LemonLime.
`LEMONLIME_HTTP_PORT` and `LEMONLIME_HTTPS_PORT` change the ports Caddy listens on.

## Database

The schema lives in `packages/db/src/schema.ts` (Drizzle, SQLite) and the SQL
migrations in `packages/db/migrations/`, in the format
`wrangler d1 migrations apply` reads. After changing the schema, run
`pnpm --filter @lemonlime/db generate`: it writes a new migration and refreshes
`packages/db/src/migrations.ts`, the embedded copy Node deployments and tests use.

| Table | Purpose |
| --- | --- |
| `user`, `session`, `account`, `verification` | Better Auth: people, sign-in sessions, linked GitHub accounts, pending sign-in codes. |
| `workspaces`, `workspace_members` | Every user gets a personal workspace at sign-up. Members are `owner` or `member`. |
| `threads` | One row per thread: agent, repo, branch, mode, status, sandbox id, runner URL, latest seq, idle and running times, first prompt. |
| `sandbox_runs` | Neutral audit log: one row per stretch of sandbox running time, with its end reason. |
| `access_tokens` | Personal access tokens for the desktop app. Only SHA-256 hashes are stored. |
| `pending_messages` | Messages sent to a thread while its sandbox was paused, waiting for the runner. |
| `secrets` | Workspace secrets passed to sandboxes, encrypted (AES-256-GCM). |
| `agent_credentials` | Agent sign-ins saved from a sandbox, encrypted, so the next sandbox starts signed in. |
| `github_installations` | GitHub App installations linked to a workspace. |
| `rate_limit` | Counters for sign-in and API rate limits. |
| `system_status` | Small service facts, such as when the idle sweep last ran (read by `/api/health`). |

SQLite has no row-level security. Every query made on behalf of a person goes
through `apps/web/src/lib/access.ts`, which checks that they belong to the
workspace (threads) or own the row (tokens). Threads in other workspaces are
reported as not found.

## Health checks and logs

`GET /api/health` is public and made for uptime monitors. It answers `200` when the
database responds and the idle sweep ran in the last 5 minutes, and `503` otherwise,
with the failing check named:

```json
{ "ok": true, "lastSweep": "2026-11-07T09:41:00.000Z", "checks": { "database": { "ok": true }, "sweep": { "ok": true }, "history": { "ok": true } } }
```

A stale sweep usually means the cron trigger (Workers) or the sweep service (Node,
Compose) stopped, and idle sandboxes are no longer being paused. Missing history
storage is reported but doesn't fail the check. Right after a fresh deploy the sweep
check fails until the first sweep runs, about a minute.

Logs: on Workers, `"observability": { "enabled": true }` in `wrangler.jsonc` keeps
request logs and errors in the Cloudflare dashboard (Workers → lemonlime-web → Logs),
and `wrangler tail` streams them live. On Node and Compose the dashboard logs to
stdout (`docker compose logs -f web`).

## Backups and restoring

Two things hold state: the database, and the thread history store. Sandboxes don't need
backing up; a thread whose sandbox is lost can be read from history and continued in a
new one. Keep the encryption secret (`LEMONLIME_TOKEN_SECRET`) somewhere safe as well:
without it, saved secrets and agent sign-ins can't be decrypted.

**Workers + D1.** D1 keeps 30 days of point-in-time history on its own:

```sh
wrangler d1 time-travel info lemonlime                       # current bookmark
wrangler d1 time-travel restore lemonlime --timestamp=2026-11-07T09:00:00Z
wrangler d1 export lemonlime --remote --output=lemonlime.sql  # a copy you keep
```

History lives in the R2 bucket; turn on bucket versioning or copy it elsewhere on a
schedule if you need more than one copy.

**Node and Compose.** Copy the SQLite file with SQLite's own backup, which is safe while
the dashboard runs, and the history folder:

```sh
docker compose exec web sqlite3 /data/lemonlime.db ".backup /data/backup.db"
docker compose cp web:/data/backup.db ./lemonlime-$(date +%F).db
docker compose cp web:/data/history ./history-$(date +%F)
```

To restore, stop the dashboard, put the files back at the same paths, and start it:

```sh
docker compose stop web sweep
docker compose cp ./lemonlime-2026-11-07.db web:/data/lemonlime.db
docker compose cp ./history-2026-11-07/. web:/data/history
docker compose start web sweep
```

Try a restore on a spare machine now and then, and check `/api/health` and an old
thread afterwards: a backup that has never been restored is only a hope.

## Thread history and paused sandboxes

Runners upload each thread's history to the control plane as they go (with every
heartbeat, and in full before a pause), so a thread can be read, and messaged, while its
sandbox is paused:

- **Storage:** the R2 bucket bound as `HISTORY` on Workers; on Node, a folder
  (`LEMONLIME_HISTORY_DIR`, default `./data/history`). Without either, threads still
  work but can only be read while their sandbox runs.
- **Pausing:** when a sandbox is due to pause, the sweep first asks its runner to *drain*
  (upload everything, save state). It pauses once the runner confirms, or after a minute.
  A runner that has stopped answering is paused straight away.
- **Background work:** builds or tests using the CPU, downloads, and dev servers that the
  agent left running keep an idle sandbox awake for up to 2 hours. Upkeep such as
  language servers and git doesn't.
- **Messages while paused:** `POST /api/threads/:id/messages` saves the message, then
  wakes the sandbox; the runner picks it up when it starts. The apps do this when you
  send to a paused thread.

## GitHub App

Cloud threads clone private repositories, push their branch after every turn, and open
pull requests through a GitHub App that each workspace installs on the repositories it
chooses. Sandboxes never hold a long-lived credential: git's credential helper asks the
control plane for a token that only works on that thread's repository and expires
within the hour.

Create the app at **GitHub → Settings → Developer settings → GitHub Apps → New**:

- **Callback URL** and **Setup URL**: `<LEMONLIME_PUBLIC_URL>/api/github/setup`
- Turn on **Request user authorization (OAuth) during installation** (LemonLime uses it
  to check that whoever installs the app can manage that installation).
- **Webhook**: off.
- **Repository permissions**: Contents *Read and write*, Pull requests *Read and write*,
  Metadata *Read-only*.
- **Where can this app be installed?** Any account, so other people can install it.

Then generate a private key and set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` (the app's URL
name), `GITHUB_APP_PRIVATE_KEY` (the PEM; newlines may be written as `\n`),
`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. People connect it under
**Settings → GitHub**.

## Secrets

People add secrets (keys and tokens their agents need, like `NPM_TOKEN`) under
**Settings → Secrets** in the dashboard, never in the chat. Each value is encrypted with
AES-256-GCM, bound to its workspace and name, and never returned by the API. New cloud
sandboxes get the workspace's secrets as environment variables; the runner removes
their values from every event before anything is stored or shown.

The encryption key is derived from `LEMONLIME_TOKEN_SECRET`, or set
`LEMONLIME_SECRETS_KEY` (32 random bytes, base64: `openssl rand -base64 32`) to keep it
separate. Changing the key makes stored secrets unreadable, so people would have to
enter them again.

## Choosing a sandbox provider

Each cloud thread gets one sandbox: `small` (1 vCPU, 2 GB) or `large`
(2 vCPU, 4 GB). The runner inside listens on port 7420; the browser connects to
it directly, so the runner URL must be reachable from wherever people use
LemonLime. Every connection must present a token signed with the thread's own
secret, so the port can be public.

- **docker** (Node deployments only) runs each sandbox as a container on the
  control plane's host and publishes the runner on `127.0.0.1:<random port>`.
  Use it for development, or when the control plane, Docker and the people
  using it are on the same machine. Pause stops the container (files kept);
  resume starts it again.
- **daytona** runs sandboxes on Daytona. The image must be available to your
  Daytona organisation (push it to a registry Daytona can pull from, or create a
  snapshot from it). Pause stops the sandbox; resume restarts it and the runner.
- **e2b** runs sandboxes on E2B. E2B sets CPU and memory per template, so build
  two templates from `docker/sandbox.Dockerfile` (1 vCPU / 2 GB and
  2 vCPU / 4 GB) and set `E2B_TEMPLATE_SMALL` and `E2B_TEMPLATE_LARGE`. Pause keeps
  memory, so the runner simply carries on after a resume.

If the dashboard is served over HTTPS, browsers only allow `wss://` runner URLs.
Daytona and E2B give HTTPS preview URLs; with Docker, serve the dashboard over
plain HTTP on the same machine or put the runner behind your own TLS proxy.

## Building the sandbox image

From the repository root:

```sh
docker build -f docker/sandbox.Dockerfile -t lemonlime/sandbox:latest .
```

The image is based on Node 22 and contains git, the runner from this
repository (`lemonlime-runner`), and the Claude Code, Codex and OpenCode CLIs.
Agents run as an unprivileged `agent` user. People bring their own model
accounts; no credentials are baked into the image.

Push it wherever your provider pulls from and set `LEMONLIME_SANDBOX_IMAGE`.

## Plugins

Deployments can change two things without forking: whether a sandbox may start
or keep running (`UsagePolicy`) and a few UI slots (`BillingUI`: a header badge,
a section on the settings page and the notice shown when an action is declined).
Both live in `packages/plugins`. The default allows everything and renders
nothing, which is what a self-hosted install wants.

The web app imports its plugin statically from `@lemonlime/deployment-plugin`
(`packages/deployment-plugin`), whose default export is `null`: no plugin. To
ship your own hooks, replace that package at build time, for example with a
pnpm override in the root `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "@lemonlime/deployment-plugin": "link:../my-plugin"
    }
  }
}
```

Your module's default export must be a `PluginExport` (see
`packages/plugins/src/index.ts`): a `LemonLimePlugin` created with
`definePlugin`, or a factory that receives `{ env }` — the request's
environment, including Worker bindings — and returns one. Because the plugin is
bundled, the same build works on Workers and on Node.

The control plane calls `canStartSandbox` before every sandbox start or resume
(a denial returns HTTP 402 with a `PolicyDenied` body), `onSandboxStarted` after
each start or resume, `onSandboxStopped` with the runtime and end reason after
each pause or stop, and `canKeepRunning` for every running sandbox during the
sweep. `canKeepRunning` also gets the sandbox's last reported `activity`: whether the
agent is mid-turn, the CPU in use and the busiest program. The runner measures these
inside the sandbox, so a policy can use them to notice runaway or unwanted work but
shouldn't treat them as proof.

## The desktop app

People create personal access tokens under **Settings** and paste one, with the
control plane URL, into the desktop app. The app sends it as
`Authorization: Bearer <token>`. Revoking a token signs that app out.

## API summary

All bodies are JSON and validated with the schemas in `packages/protocol`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/threads` | session or token | Create a thread (`CreateThreadRequest`). Cloud threads start a sandbox and return a runner endpoint with a 15-minute client token. |
| `GET /api/threads` | session or token | List threads in the workspace (`?workspace=<id>` optional). |
| `GET /api/threads/:id` | session or token | The thread, plus a fresh endpoint and token while its sandbox runs. |
| `POST /api/threads/:id/pause` | session or token | Pause the sandbox. |
| `POST /api/threads/:id/resume` | session or token | Resume the sandbox (402 if the usage policy declines). |
| `DELETE /api/threads/:id` | session or token | Close the thread and delete its sandbox. |
| `POST /api/runner/heartbeat` | runner token | Runner status (`RunnerHeartbeat` → `HeartbeatResponse`). |
| `POST /api/cron/sweep` | cron secret | Pause idle and disallowed sandboxes (Node deployments). |
| `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | session (create), session or token (list, revoke) | Personal access tokens. The raw value is returned once, on create. |
| `GET /api/health` | — | Health for uptime monitors: 200 or 503 with the failing check. |
| `/api/auth/*` | — | Better Auth: sign-in codes, GitHub sign-in, sessions. |
