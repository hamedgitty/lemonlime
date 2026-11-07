# Contributing to LemonLime

Thanks for helping. LemonLime runs coding agents on your own computer or in cloud
sandboxes. This guide covers how to get set up, what we expect in a change, and how
reviews work.

## Set up

You need Node 22+, pnpm 11 and git. The desktop app also needs Rust and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm hooks        # optional: run the boundary check (and gitleaks, if installed) before each commit
pnpm check        # everything CI runs: boundary, lint, formatting, types, tests
```

Useful commands:

| Command | What it does |
| --- | --- |
| `pnpm test` | All tests (Vitest) |
| `pnpm typecheck` | Type-check every package |
| `pnpm lint` / `pnpm format` | Lint with oxlint, format with Prettier |
| `pnpm dev:web` | Dashboard on Node + a local SQLite file; sign-in codes print to the console |
| `pnpm dev:desktop` | Desktop app (needs Rust) |
| `pnpm runner -- --help` | The runner's command line |

The layout and core ideas are in [`CLAUDE.md`](CLAUDE.md) and [`docs/`](docs).

## What a good change looks like

- **Small and focused.** One idea per pull request. Open an issue first for anything big.
- **Tested.** New behaviour comes with a test; bug fixes come with a test that failed before.
  Agent adapters are checked against recorded real runs (`packages/runner/test/fixtures/agents`);
  if you change how we talk to an agent, re-record with `pnpm --filter @lemonlime/runner record <agent>`.
- **Self-contained.** Code only depends on packages declared in this repo. `pnpm boundary`
  enforces it, and fails on anything that looks like a secret.
- **The same for everyone.** No "if hosted" branches: behaviour that a deployment wants to
  change goes through the hooks in `packages/plugins`, whose defaults allow everything.
- **Plain words.** Commit messages and UI text are short, plain English, e.g.
  "Queue messages sent while the agent is busy".

## Pull requests

1. Fork, branch from `main`, make your change.
2. Run `pnpm check`.
3. Open a pull request and fill in the template. CI runs the same checks plus a secret scan
   and a build of the desktop app.
4. A maintainer reviews. We may ask for changes; small follow-ups are fine as new commits.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).

## Reporting bugs and security issues

Bugs: open an issue with the bug template. Security problems: please **don't** open an
issue; follow [`SECURITY.md`](SECURITY.md).
