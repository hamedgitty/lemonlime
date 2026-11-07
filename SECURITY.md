# Security policy

LemonLime runs coding agents that can read and change code and run commands, so we take
security reports seriously.

## Reporting a vulnerability

Please report privately, not in a public issue:

- Use GitHub's **Report a vulnerability** button on the repository's Security tab
  (private vulnerability reporting).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll
get an acknowledgement within 3 working days and a plan within 10. We'll credit you in
the release notes unless you'd rather we didn't.

## What's in scope

- The runner (`packages/runner`): token checks, the approval channel, sandbox escapes of
  its own making, command and path handling.
- The control plane and dashboard (`apps/web`): sign-in, access checks, tokens.
- The desktop app (`apps/desktop`): anything that lets a web page, an agent or a cloud
  sandbox act on your computer without your say-so.
- Sandbox providers (`packages/sandbox`) and the sandbox image (`docker/`).

Out of scope: bugs in the agent CLIs themselves (report those to their makers), and
problems that need an attacker who already controls your machine.

## Supported versions

Fixes land on `main` and in the next release. Please test against the latest release.
