# Sandbox image for LemonLime cloud threads.
#
# Contains Node 22, git, the LemonLime runner from this repository, and the
# Claude Code, Codex and OpenCode CLIs. Build from the repository root:
#
#   docker build -f docker/sandbox.Dockerfile -t lemonlime/sandbox:latest .
#
# The control plane starts the runner with a command like
#   lemonlime-runner --thread <id> --agent <kind> --repo <url> --base <branch> \
#     --host 0.0.0.0 --port 7420 --control-plane <url>
# and LEMONLIME_THREAD_SECRET in the environment. With the provider's agent-user setting the
# secret stays with a keeper running as root instead (see docs/runner.md, Tokens).

FROM node:22-bookworm-slim

ARG PNPM_VERSION=11.28.2
# Agent CLI versions LemonLime is tested with. Keep in step with TESTED_AGENTS in
# packages/runner/src/agents/versions.ts (a test checks this).
ARG CLAUDE_CODE_VERSION=2.1.302
ARG CODEX_VERSION=0.167.0
ARG OPENCODE_VERSION=1.18.18

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates openssh-client curl ripgrep less procps build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Users sign in with their own model accounts; nothing is baked in.
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force

RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}" && npm cache clean --force

# The runner and the workspace packages it uses, installed from this checkout.
WORKDIR /opt/lemonlime
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/runner/package.json packages/runner/package.json
RUN pnpm install --frozen-lockfile --prod --filter "@lemonlime/runner..."
COPY packages/protocol packages/protocol
COPY packages/runner packages/runner
RUN chmod +x packages/runner/bin/lemonlime-runner.js \
 && ln -s /opt/lemonlime/packages/runner/bin/lemonlime-runner.js /usr/local/bin/lemonlime-runner

# Agents run as an unprivileged user in their own home directory.
RUN useradd --create-home --shell /bin/bash agent \
 && git config --system init.defaultBranch main \
 && git config --system user.name "LemonLime Agent" \
 && git config --system user.email "agent@localhost"
USER agent
WORKDIR /home/agent

ENV LEMONLIME_RUNNER_PORT=7420
# Tells the runner it is inside an isolated sandbox: cloud mode, full agent autonomy.
ENV LEMONLIME_SANDBOX=1
EXPOSE 7420

# Providers override the command with the runner invocation above.
CMD ["lemonlime-runner", "--help"]
