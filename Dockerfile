# syntax=docker/dockerfile:1
# Blizzbeat: Discord music bot + built-in Lavalink in a single container.
FROM node:22-bookworm-slim

ARG LAVALINK_VERSION=4.2.2

ENV NODE_ENV=production \
    DATA_DIR=/data \
    LAVALINK_DIR=/opt/lavalink \
    JAVA_OPTS="-Xms128m -Xmx512m"

# Java 17 runtime for Lavalink, curl for downloads/health checks, tini as PID 1.
RUN mkdir -p /usr/share/man/man1 \
 && apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Lavalink server. Plugins (YouTube, LavaSrc/Spotify) are fetched on first start into a volume.
RUN mkdir -p "$LAVALINK_DIR/plugins" \
 && curl -fsSL -o "$LAVALINK_DIR/Lavalink.jar" \
    "https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY assets/banner.png assets/avatar.png ./assets/
COPY docker ./docker

RUN chmod +x docker/*.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data "$LAVALINK_DIR"

# The entrypoint starts as root only to fix folder ownership for PUID/PGID, then drops to that user.
ENV PUID=1000 PGID=1000
VOLUME ["/data", "/opt/lavalink/plugins"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=3 CMD ["/app/docker/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
