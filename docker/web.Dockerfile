# Control plane + dashboard (apps/web) on Node with a SQLite file, for self-hosting.
# Used by compose.yaml; build from the repository root:
#
#   docker build -f docker/web.Dockerfile -t lemonlime/web .
#
# Base images are named by tag and by digest, so a rebuild gets the same base every time.
# To move to a newer one, take the Digest line of
#   docker buildx imagetools inspect node:22-bookworm-slim
# (and the same for docker:27-cli).

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ARG PNPM_VERSION=11.28.2
RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @lemonlime/web build

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# The docker sandbox provider drives Docker through its CLI (with the host's socket mounted).
# That socket is full control of Docker on the host whichever user this container runs as;
# docs/self-hosting.md says what that means and how to narrow it.
COPY --from=docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c /usr/local/bin/docker /usr/local/bin/docker
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
