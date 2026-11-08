# Control plane + dashboard (apps/web) on Node with a SQLite file, for self-hosting.
# Used by compose.yaml; build from the repository root:
#
#   docker build -f docker/web.Dockerfile -t lemonlime/web .

FROM node:22-bookworm-slim AS build
ARG PNPM_VERSION=11.28.2
RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @lemonlime/web build

FROM node:22-bookworm-slim
# The docker sandbox provider drives Docker through its CLI (with the host's socket mounted).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 LEMONLIME_DATABASE_URL=file:/data/lemonlime.db
VOLUME /data
EXPOSE 3000
WORKDIR /app/apps/web
# server.ts is `next start` plus the phone bridge's WebSockets (docs/phone-access.md).
ENV PORT=3000
CMD ["node", "server.ts"]
