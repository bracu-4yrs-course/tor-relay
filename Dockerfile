# syntax=docker/dockerfile:1.4
# tor-relay — Docker image (HuggingFace Spaces / Railway / any Docker host).
#
# ONE container, TWO residents:
#   1. the Next.js standalone server (this app — dashboard + /api/proxy)
#   2. the tor daemon, spawned as a CHILD PROCESS of the app by TorSupervisor
#      (src/lib/tor.ts). The supervisor writes its own torrc, waits for SOCKS
#      readiness on 127.0.0.1:9050 and auto-restarts tor if it dies — so the
#      container needs no init/supervisor of its own; the app IS the supervisor.
#
# TorSupervisor discovers the binary at /usr/bin/tor (first hardcoded
# candidate), so apt-installing tor is the whole setup. If no tor binary
# exists it can also self-bootstrap by downloading the .debs at first boot —
# but the apt path below is the reliable one.
#
# Runtime contract:
#   - binds 0.0.0.0:$PORT (HF Spaces: PORT=7860 baked below; Railway injects
#     PORT and its injected value overrides image ENV)
#   - SQLite at DATABASE_URL (default file:/tmp/netd.db — /tmp is writable)
#   - tor data dir defaults to $HOME/.local/share/netd (NETD_DATA overrides)
#   - lock the relay with PROXY_KEY env or the dashboard Settings password
FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive

# tor: the whole point. ca-certificates for outbound TLS. curl for probes.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tor ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# HF Spaces runs containers as UID 1000 — create the user up front.
RUN useradd -m -u 1000 -s /bin/bash user \
    && mkdir -p /app \
    && chown -R 1000:1000 /app

WORKDIR /app
ENV HOME=/home/user \
    NEXT_TELEMETRY_DISABLED=1

# Dependencies first (layer stays cached while only app code changes).
# npm ci also downloads the prisma engines (query/schema) into node_modules,
# so the runtime `prisma db push` in `npm start` needs no network.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# App source, then the standalone build:
#   prisma generate + next build + copy static/public into .next/standalone
# (see the "build" script in package.json).
COPY . .
RUN npm run build \
    && chown -R 1000:1000 /app

# --- runtime ----------------------------------------------------------------
ENV PORT=7860 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/tmp/netd.db

USER 1000
EXPOSE 7860

# npm start = npx prisma db push (create SQLite schema) + exec the standalone
# Next.js server on 0.0.0.0:$PORT (see package.json "start" script).
CMD ["npm", "start"]
