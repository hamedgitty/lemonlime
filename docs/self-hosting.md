# Self-hosting the control plane

The control plane (`apps/web`) is a Next.js app on Supabase. It signs people in,
keeps the list of threads, starts, pauses and resumes cloud sandboxes, and issues
the short-lived tokens that apps use to talk to a thread's runner. It never sees
the live conversation: apps connect to the runner directly over WebSocket.

```
browser / desktop ──(WebSocket + client token)──▶ runner (in the sandbox)
        │                                             │
        └──(HTTPS)──▶ control plane ◀──── heartbeats ─┘
                          │
                          ├──▶ Supabase (auth + Postgres)
                          └──▶ SandboxProvider: docker | daytona | e2b
```

You need Node 22+, pnpm 11, a Supabase project (hosted or local), and one sandbox
provider. Local threads (agents on your own computer, driven by the desktop app)
only need the control plane for sign-in and the thread list.

## 1. Supabase

### Local

```sh
cd apps/web
supabase start            # needs Docker; prints the API URL, anon key and service role key
supabase migration up     # applies supabase/migrations
```

Magic-link emails go to the local inbox printed by `supabase start`
(by default <http://127.0.0.1:54324>).

### Hosted Supabase project

1. Create a project.
2. Apply the schema: `supabase link --project-ref <ref>` then `supabase db push`
   from `apps/web`, or paste `apps/web/supabase/migrations/0001_init.sql` into the
   SQL editor.
3. In **Authentication → URL configuration** set the site URL to your
   control plane URL and add `<your URL>/auth/callback` to the redirect URLs.
4. Email magic links work out of the box. For production use, configure your own
   SMTP server in the Supabase dashboard.
5. Optional GitHub sign-in: create a GitHub OAuth app whose callback is
   `https://<project>.supabase.co/auth/v1/callback`, enable the GitHub provider
   in Supabase, and set `NEXT_PUBLIC_SUPABASE_GITHUB=1`.

### What the schema contains

| Table | Purpose |
| --- | --- |
| `workspaces`, `workspace_members` | Every user gets a personal workspace at sign-up (database trigger). Members are `owner` or `member`. |
| `threads` | One row per thread: agent, repo, branch, mode, status, sandbox id, runner URL, latest seq, idle and running times. |
| `sandbox_runs` | Neutral audit log: one row per stretch of sandbox running time, with its end reason. |
| `access_tokens` | Personal access tokens for the desktop app. Only SHA-256 hashes are stored. |

Row-level security lets signed-in users read only their own workspaces' rows.
All writes go through the control plane's API, which uses the service role key
and checks membership itself.

## 2. Environment variables

Copy the template and fill it in. Next.js reads env files from the app directory:

```sh
cp .env.example apps/web/.env.local
```

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase API URL. Needed at build time too (it is inlined into the browser bundle). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon key. Also needed at build time. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server only. Never expose it to browsers. |
| `NEXT_PUBLIC_SUPABASE_GITHUB` | no | `1` shows the GitHub sign-in button. |
| `LEMONLIME_PUBLIC_URL` | yes | Public URL of the control plane. Runners send heartbeats to `<url>/api/runner/heartbeat`, so sandboxes must be able to reach it. |
| `LEMONLIME_TOKEN_SECRET` | yes | Master secret, at least 16 characters (`openssl rand -hex 32`). Each thread's secret is derived from it. Changing it invalidates every running sandbox's tokens. |
| `LEMONLIME_CRON_SECRET` | yes | Bearer secret for `/api/cron/sweep`. |
| `LEMONLIME_SANDBOX_PROVIDER` | yes | `docker`, `daytona` or `e2b`. |
| `LEMONLIME_SANDBOX_IMAGE` | yes | Image with the runner and agent CLIs (see below). |
| `LEMONLIME_PLUGIN` | no | Module specifier of a plugin (see "Plugins"). Leave empty. |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL` | daytona | |
| `E2B_API_KEY`, `E2B_TEMPLATE_SMALL`, `E2B_TEMPLATE_LARGE` | e2b | |

The app builds without any of these set; missing values only fail the requests
that need them, with a message naming the variable.

## 3. Choosing a sandbox provider

Each cloud thread gets one sandbox: `small` (1 vCPU, 2 GB) or `large`
(2 vCPU, 4 GB). The runner inside listens on port 7420; the browser connects to
it directly, so the runner URL must be reachable from wherever people use
LemonLime. Every connection must present a token signed with the thread's own
secret, so the port can be public.

- **docker** runs each sandbox as a container on the control plane's host and
  publishes the runner on `127.0.0.1:<random port>`. Use it for development, or
  when the control plane, Docker and the people using it are on the same
  machine. Pause stops the container (files kept); resume starts it again.
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

## 4. Building the sandbox image

From the repository root:

```sh
docker build -f docker/sandbox.Dockerfile -t lemonlime/sandbox:latest .
```

The image is based on Node 22 and contains git, the runner from this
repository (`lemonlime-runner`), and the Claude Code, Codex and OpenCode CLIs.
Agents run as an unprivileged `agent` user. People bring their own model
accounts; no credentials are baked into the image.

Push it wherever your provider pulls from and set `LEMONLIME_SANDBOX_IMAGE`.

## 5. Running the control plane

```sh
pnpm install
pnpm --filter @lemonlime/web build
pnpm --filter @lemonlime/web start          # or: pnpm dev:web during development
```

Any Node host works. Long-running requests: creating or resuming a sandbox
waits for the provider, which can take tens of seconds, so allow at least 2
minutes per request if your host has a timeout.

## 6. Scheduling the sweep

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

A systemd timer, a Kubernetes CronJob or your platform's scheduled jobs work
just as well. The response lists what was checked and paused.

## 7. Plugins

Deployments can change two things without forking: whether a sandbox may start
or keep running (`UsagePolicy`) and a few UI slots (`BillingUI`: a header badge,
a section on the settings page and the notice shown when an action is declined).
Both live in `packages/plugins`. The default plugin allows everything and renders
nothing, which is what a self-hosted install wants.

To use a plugin, install it next to the app (or give an absolute path) and set
`LEMONLIME_PLUGIN` to its module specifier. Its default export is a
`LemonLimePlugin` created with `definePlugin`. If the module fails to load, the
control plane refuses to start sandboxes rather than running without it.

The control plane calls `canStartSandbox` before every sandbox start or resume
(a denial returns HTTP 402 with a `PolicyDenied` body), `onSandboxStarted` after
each start or resume, `onSandboxStopped` with the runtime and end reason after
each pause or stop, and `canKeepRunning` for every running sandbox during the
sweep.

## 8. The desktop app

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
| `POST /api/cron/sweep` | cron secret | Pause idle and disallowed sandboxes. |
| `GET/POST /api/tokens`, `DELETE /api/tokens/:id` | session (create), session or token (list, revoke) | Personal access tokens. The raw value is returned once, on create. |
