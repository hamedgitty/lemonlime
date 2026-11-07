# LemonLime

**Your coding agents keep working after you close your laptop.**

LemonLime runs AI coding agents — Claude Code, Codex, OpenCode, and any agent that
speaks the [Agent Client Protocol](https://agentclientprotocol.com) — on your own
computer or in isolated cloud sandboxes, each on its own git branch.

- **Bring your own model account.** LemonLime never proxies or bills model calls.
- **One agent, one sandbox.** Every cloud thread gets its own machine; idle ones pause
  automatically after 5 minutes.
- **Pick up anywhere.** Every thread keeps an append-only history you can resume from
  any point, from the desktop app or the web dashboard.
- **Free and open source (MIT).** Self-hosting is free and unlimited.

## What's inside

| Path | What it is |
| --- | --- |
| `packages/protocol` | Schemas and types for every message between app, control plane and runner |
| `packages/runner` | Daemon that runs next to one agent: spawns the CLI, streams events, keeps history and the git branch |
| `packages/sandbox` | Sandbox providers: Docker, Daytona, E2B |
| `packages/client` | WebSocket client with resume and reconnect |
| `packages/plugins` | Extension hooks for deployments (defaults allow everything) |
| `packages/db` | Database schema and migrations (SQLite: Cloudflare D1 or a local file) |
| `apps/web` | Control plane and dashboard (Next.js on Cloudflare Workers + D1, or any Node server) |
| `apps/desktop` | Desktop app for macOS, Windows and Linux (Tauri) |

## Quick start: run an agent locally

```bash
pnpm install
cd /path/to/your/repo
LEMONLIME_THREAD_SECRET=$(openssl rand -hex 32) \
  pnpm --dir /path/to/lemonlime runner -- --thread my-first-thread --agent claude-code --source-repo .
```

The runner creates the branch `agent/my-first-thread` in its own git worktree under
`~/.lemonlime/worktrees`, so your checked-out branch and uncommitted work are never
touched. It serves the thread on `ws://127.0.0.1:7420/ws` and commits the agent's
changes to that branch after every turn. The desktop app does all of this for you.

## Docs

- [Runner](docs/runner.md)
- [Self-hosting](docs/self-hosting.md)

## Contributing

Run `pnpm test` and `pnpm typecheck` before opening a pull request. Please read
[CLAUDE.md](CLAUDE.md) for the project's ground rules.

## License

[MIT](LICENSE)
