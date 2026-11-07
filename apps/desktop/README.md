# LemonLime desktop

The desktop app for LemonLime, built with Tauri 2, React 19, Vite and Tailwind CSS v4.

- **Local threads** run an agent on this computer. The app starts one
  `lemonlime-runner` per thread, bound to `127.0.0.1` on a free port, and talks
  to it over a WebSocket.
- **Cloud threads** run in sandboxes managed by a LemonLime control plane
  (`apps/web`, or your own deployment). Add its URL and a personal access token
  in Settings.

## Prerequisites

- Node.js 22+ and pnpm 11 (see the repository root).
- Rust (stable, 1.77.2 or newer) via [rustup](https://rustup.rs).
- The Tauri system dependencies for your platform, as described in the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/):
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and
    the WebView2 runtime (preinstalled on Windows 10 21H2+ and Windows 11).
  - **Linux (Debian/Ubuntu):**
    ```sh
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    ```
    Other distributions: see the guide above.
- Git, and the CLI for each agent you want to use (`claude`, `codex`,
  `opencode`, or your ACP agent), signed in with your own account.
- The runner. Either put `lemonlime-runner` on your PATH, or point Settings →
  Runner binary at `packages/runner/bin/lemonlime-runner.js` in this checkout
  (the app runs `.js` paths with Node).

## Run it

From the repository root:

```sh
pnpm install
pnpm --filter @lemonlime/desktop tauri dev   # or: pnpm dev:desktop
```

`tauri dev` starts Vite on port 1420 and opens the app window. The first run
compiles the Rust side, which takes a few minutes.

To work on the interface only, `pnpm --filter @lemonlime/desktop dev:web` serves
it in a browser at http://localhost:1420. Cloud threads work there (the control
plane must allow the origin via CORS); local threads need the desktop shell.

Other scripts:

```sh
pnpm --filter @lemonlime/desktop typecheck
pnpm --filter @lemonlime/desktop build        # frontend only, into dist/
pnpm --filter @lemonlime/desktop tauri build  # installable app for this OS
pnpm test                                     # from the root; includes apps/desktop/test
```

## How local threads start

1. You pick a repository folder, an agent and (optionally) a model and first prompt.
   The app creates a thread id and remembers the thread in local storage.
2. The frontend calls the Rust command `start_local_runner`. It generates a
   random 32-byte thread secret, picks a free port, and spawns:
   ```
   lemonlime-runner --thread <id> --agent <kind> [--agent-command <cmd>] [--model <name>]
                    --source-repo <repo> --base <branch> --port <port> --host 127.0.0.1
   ```
   with `LEMONLIME_THREAD_SECRET` in the environment. It waits until the port
   accepts connections, then returns `{ port, secret }`. Runner output goes to
   `runner-<thread-id>.log` in the app's log folder.
3. The frontend signs short-lived `client` tokens with that secret
   (`signToken` from `@lemonlime/protocol`) and connects `RunnerClient` to
   `ws://127.0.0.1:<port>/ws`, resuming after the last event it has cached.
4. "Stop runner" sends the runner SIGTERM (or ends its process tree on
   Windows). Every runner is stopped when the app quits.

The agent works on the thread's own branch, `agent/<thread-id>`, in a separate git
worktree under `~/.lemonlime/worktrees`, so it never switches your branch or touches
your uncommitted work. Removing a thread runs `lemonlime-runner cleanup`, which deletes
the worktree and local history but keeps the branch.

## Layout

```
src/                 React app
  components/        Sidebar, thread view, timeline, diff view, dialogs
  lib/               Pure logic (timeline, diff parsing, storage, cloud API) and the session hook
src-tauri/           Rust shell: runner processes, git check, plugins, config
test/                Vitest tests for the pure logic
```

## Icons

`src-tauri/icons` holds simple generated placeholder icons. To replace them,
run `pnpm --filter @lemonlime/desktop tauri icon path/to/icon.png` with a
1024×1024 PNG.
