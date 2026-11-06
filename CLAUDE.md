# LemonLime — notes for coding agents

LemonLime is an open-source app for running AI coding agents (Claude Code, Codex,
OpenCode, and any ACP agent) on the user's own computer or in isolated cloud
sandboxes. Pitch: **"Your coding agents keep working after you close your laptop."**

Users bring their own model accounts. LemonLime never proxies, meters or bills
model calls.

## Ground rules (read before every change)

1. **This repo is public (MIT).** Anything you write here — code, comments, docs,
   commit messages, issues, changelogs — is visible to everyone.
2. **No hosted-business details here.** Prices, plans, limits, quotas, customers,
   abuse rules and production infrastructure do not belong in this repo. If a
   task needs one of those, add a *hook* here (see `packages/plugins`) and stop.
   When unsure whether something belongs here, ask first.
3. **No "if hosted" branches.** Public code must behave the same for everyone.
   Behaviour that differs for a hosted deployment goes through the plugin hooks,
   whose defaults allow everything and render nothing.
4. **Never reference outside packages or URLs** that are not part of this repo or
   a public dependency.
5. **No real secrets.** `.env.example` holds placeholders only.
6. **Commits** are authored by the repo owner only, with no co-author or tool
   trailers. Messages are short, plain English that anyone can understand,
   e.g. "Add idle auto-pause for cloud sandboxes".

## Layout

```
packages/
  protocol/   Zod schemas + types for every message between app, control plane and runner
  runner/     Node daemon that runs next to one agent; spawns the CLI, streams events,
              stores history, manages the thread's git branch
  sandbox/    SandboxProvider interface + Docker, Daytona and E2B implementations
  plugins/    UsagePolicy and BillingUI hook types with allow-all / render-nothing defaults
  deployment-plugin/  The plugin bundled into the web app (default: none); deployments replace it at build time
  db/         Drizzle schema (SQLite) + migrations; D1 on Workers, libSQL file on Node and in tests
apps/
  web/        Next.js control plane (auth, threads, provisioning, tokens, dashboard) on
              Cloudflare Workers + D1 (OpenNext) or plain Node + SQLite; Better Auth for sign-in
  desktop/    Tauri 2 + React + Tailwind desktop app
skills/       Bundled agent skills
docs/         Self-hosting and architecture docs
```

## Core concepts

- **Thread** — one conversation with one agent. Has an id, agent type, repo,
  branch (`agent/<thread-id>`), mode (`local` | `cloud`), status and an
  append-only event history.
- **Event** — a typed record (`user_message`, `agent_message`, `tool_call`,
  `tool_result`, `file_diff`, `status_change`, `error`) with a monotonic `seq`
  per thread, so any client can resume from any point.
- **Sandbox** — one per cloud thread. `small` (1 vCPU / 2 GB) by default, or
  `large` (2 vCPU / 4 GB). Idle sandboxes auto-pause after 5 minutes.
- **Runner** — the daemon next to the agent. Clients talk to it directly over a
  WebSocket for the live session; the control plane only starts, pauses and
  tracks sandboxes.

## How the pieces talk

```
desktop / web ──(WebSocket, runner token)──▶ runner ──(stdio)──▶ agent CLI
       │                                        │
       └──(HTTPS)──▶ control plane ◀──heartbeat─┘
                        │
                        └──▶ SandboxProvider (docker | daytona | e2b)
```

There is no row-level security: every user-facing query in `apps/web` goes
through `apps/web/src/lib/access.ts`, which checks workspace membership. Keep it
that way when adding routes.

The control plane asks the configured `UsagePolicy` before starting or resuming
a sandbox, and reports start/stop events to it. Self-hosted installs use the
default policy, which always says yes.

## Commands

```
pnpm install
pnpm test          # vitest across all packages
pnpm typecheck
pnpm runner -- --help
pnpm dev:web       # Node + local SQLite; sign-in codes print to the console
pnpm --filter @lemonlime/web cf:preview   # the Workers build under wrangler dev
pnpm dev:desktop   # needs Rust + the Tauri prerequisites
```
