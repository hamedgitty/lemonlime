# Agent plugins

An agent plugin bundles skills, slash commands, subagents and MCP servers for coding
agents. LemonLime uses the widely used plugin layout, so plugins written for it work
without changes. Install them in the desktop app's Plugins page; every enabled plugin is
added to each new local thread.

(These are not the same as `packages/plugins`, which holds the hooks a hosted deployment
uses. That package has nothing to do with the agents.)

## What a plugin looks like

```
my-plugin/
  .claude-plugin/plugin.json   name, description, version, author, homepage (required)
  skills/<name>/SKILL.md       skills
  commands/<name>.md           slash commands (subfolders allowed)
  agents/<name>.md             subagent definitions
  .mcp.json                    MCP servers: { "mcpServers": { "<name>": { ... } } }
  hooks/hooks.json             hooks (listed, never run; see below)
  README.md                    shown as the plugin's overview
```

`plugin.json` needs only a `name` (letters, numbers, dots, dashes and underscores, at most
64). It may also give `description`, `version`, `author` (text or `{ "name": ... }`),
`homepage` and `license`, and extra places to look for `commands`, `agents` and `skills`
(a path or a list of paths), plus `mcpServers` and `hooks` (a path to a JSON file, or the
object itself). In any of these, and in commands, subagents and MCP server settings,
`${CLAUDE_PLUGIN_ROOT}` means the plugin's own folder.

An MCP server is either a program (`command`, `args`, `env`) or a remote server
(`"type": "http"` or `"sse"`, `url`, `headers`). Server names use letters, numbers, dashes
and underscores.

### Marketplaces

A repository with `.claude-plugin/marketplace.json` instead of `plugin.json` lists several
plugins. Leave **Plugin** empty and LemonLime installs each one whose `source` is a folder
in the same repository (`"./plugins/name"`, or a bare name under `metadata.pluginRoot`), up
to 100. Type a plugin's name to install just that one; it may then also live in another
repository: a `url` source (a whole repository), a `git-subdir` source (a folder in one),
or a `github` source (`owner/name`), following the entry's `ref` and pinned `sha` when it
has them. `https://` only; `command` sources are never run. A listed plugin without its own
`plugin.json` uses its marketplace entry as its manifest, and a plugin installs under the
name its own `plugin.json` gives. Plugins from a marketplace start turned off unless you
picked one by name.

## Installing

In the desktop app, open Plugins and use **New plugin**:

- **Install from Git URL…** clones an `https://` repository (optionally a branch or tag)
  with your system `git`, shallowly, checks it, and moves it into place. Links must not
  contain sign-in details; git asks for them if the repository is private.
- **Install from a folder…** copies a folder from this computer.
- **Create a plugin with an agent** starts a thread that writes one with you.

Each plugin is checked before it is installed and again every time a thread starts:

- no symbolic links anywhere, and no paths that point outside the plugin;
- each file at most 5 MB, the whole plugin at most 50 MB and 5,000 files, at most 16
  folders deep; JSON files at most 1 MB;
- `plugin.json`, `.mcp.json`, `hooks.json` and `marketplace.json` must be valid.

## Where plugins live

```
~/.lemonlime/plugins/            ($LEMONLIME_HOME/plugins if that is set)
  plugins.json                   the registry
  <name>/                        one folder per plugin (no .git inside)
```

`plugins.json` looks like this:

```json
{
  "plugins": [
    {
      "name": "review-kit",
      "source": "https://example.com/acme/review-kit.git",
      "version": "1.2.0",
      "enabled": true,
      "installedAt": "2026-11-01T10:00:00Z",
      "updatedAt": "2026-11-01T10:00:00Z",
      "commit": "8f3c2a1d9e0b4c5f6a7b8c9d0e1f2a3b4c5d6e7f"
    }
  ]
}
```

`source` is an `https://` git URL or a folder path. Git plugins may also have `ref` (the
branch or tag they follow) and `path` (their folder inside the repository). A plugin picked
from a marketplace but kept in another repository records that other repository.

**Update** fetches the source again (a fresh shallow clone, or a fresh copy of the folder),
checks it, and swaps it in; the plugin stays on or off as it was. The Updates tab asks
each git plugin's repository for its newest commit (`git ls-remote`, nothing downloaded)
and lists the ones that changed. **Remove** deletes the plugin's folder and its entry.

## What each agent gets

The desktop app starts each local runner with `--plugins-dir ~/.lemonlime/plugins` when
that folder exists. The runner reads `plugins.json`, checks every enabled plugin, and puts
what it gives into the thread's worktree, kept out of git through the repository's local
exclude file:

| | Claude Code | Codex | OpenCode | ACP agents |
| --- | --- | --- | --- | --- |
| Skills | `.claude/skills/<skill>` | `.agents/skills/<skill>` | `.agents/skills/<skill>` | `.agents/skills/<skill>` |
| Slash commands | `.claude/commands/<plugin>/` | no | no | no |
| Subagents | `.claude/agents/<plugin>-<name>.md` | no | no | no |
| MCP servers | added to `--mcp-config` | `-c mcp_servers.<name>...` | no | no |
| Hooks | never run | never run | never run | never run |

- A plugin skill never replaces one the thread already has (LemonLime's own or yours);
  the thread gets a notice instead.
- MCP servers keep their own name unless LemonLime or another plugin already uses it, in
  which case they become `<plugin>-<server>`. Their tools follow the thread's autonomy:
  at "edits", Claude Code asks you before using them. Codex has no SSE transport, so SSE
  servers reach Claude Code only.
- Claude Code also has its own `--plugin-dir` option. LemonLime copies the parts in
  instead, so it works with every Claude Code version and so plugin hooks never run.
- Plugins are read when a thread's runner starts. Changes reach new threads, and running
  threads when their runner restarts; what a plugin added is removed again from a thread
  once the plugin is turned off or removed.
- Problems with one plugin (for example a folder that was edited by hand and now fails a
  check) are shown as a notice in the thread; the other plugins still load.

## Hooks are not applied

Hooks run a command on every tool call, even when permissions are skipped, and can approve
a tool call on their own, which would get around LemonLime's approvals and command guard.
So LemonLime lists a plugin's hook events (in the Plugins page and in `read_plugin`) but
never runs them.

## Desktop commands

The Rust commands in `apps/desktop/src-tauri/src/plugins.rs`, wrapped in
`apps/desktop/src/lib/plugins.ts`:

| Command | Does |
| --- | --- |
| `list_plugins` | Every installed plugin with what it gives |
| `read_plugin(name)` | One plugin, with its licence and README |
| `install_plugin_from_git(url, gitRef?)` | Clone, check and install (a plugin or a marketplace) |
| `install_plugin_from_folder(path)` | Copy, check and install |
| `set_plugin_enabled(name, enabled)` | Turn on or off for new threads |
| `update_plugin(name)` | Fetch the source again and swap the new copy in |
| `remove_plugin(name)` | Delete it |
| `check_plugin_updates` | Which git plugins have a newer commit |
| `plugins_folder` | Where plugins live |
