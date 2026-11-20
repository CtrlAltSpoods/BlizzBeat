# syntax=docker/dockerfile:1
# Blizzbeat: Discord music bot + built-in Lavalink (+ yt-cipher for YouTube) in a single container.

# --- yt-cipher: decodes YouTube's stream signatures for Lavalink's YouTube plugin -----------------
# Cross-compiled on the build machine (no emulation) into a single binary for the target platform.
FROM --platform=$BUILDPLATFORM denoland/deno:latest AS ytcipher
ARG TARGETARCH
ARG YTCIPHER_COMMIT=1e1fd8e2f34ca90cf23545be72e46307bd3d3d2a
ARG EJS_COMMIT=cd4e87f52e87ab6d8b318fd3a817adda6fafa8dc
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/kikkia/yt-cipher.git \
 && git fetch -q --depth 1 origin "$YTCIPHER_COMMIT" && git checkout -q FETCH_HEAD \
 && git init -q ejs && cd ejs && git remote add origin https://github.com/yt-dlp/ejs.git \
 && git fetch -q --depth 1 origin "$EJS_COMMIT" && git checkout -q --detach FETCH_HEAD && cd .. \
 && deno run --allow-read --allow-write ./scripts/patch-ejs.ts \
 && rm -rf ejs/.git ejs/node_modules
RUN case "$TARGETARCH" in arm64) target=aarch64-unknown-linux-gnu ;; *) target=x86_64-unknown-linux-gnu ;; esac \
 && deno compile --no-check --target "$target" --output /out/server \
      --allow-net --allow-read --allow-write --allow-env --include worker.ts server.ts \
 && cp -r docs /out/docs && mkdir -p /out/player_cache

# --- Blizzbeat ------------------------------------------------------------------------------------
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

COPY --from=ytcipher /out /opt/yt-cipher

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY assets/banner.png assets/avatar.png ./assets/
COPY docker ./docker

RUN chmod +x docker/*.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data "$LAVALINK_DIR" /opt/yt-cipher

# The entrypoint starts as root only to fix folder ownership for PUID/PGID, then drops to that user.
ENV PUID=1000 PGID=1000
VOLUME ["/data", "/opt/lavalink/plugins"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=240s --retries=3 CMD ["/app/docker/healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
