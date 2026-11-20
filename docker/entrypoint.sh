#!/usr/bin/env bash
# Starts the built-in Lavalink server, waits for it, then starts the Blizzbeat bot.
# If either process exits, the container exits so Docker's restart policy can bring it back.
set -euo pipefail

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [entrypoint] $*"; }

if [[ -z "${DISCORD_TOKEN:-}" ]]; then
  log "ERROR: DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in."
  exit 1
fi

LAVALINK_DIR="${LAVALINK_DIR:-/opt/lavalink}"
DATA_DIR="${DATA_DIR:-/data}"

# Started as root (the default): fix folder ownership for PUID/PGID, then drop privileges.
# Unraid uses PUID=99 PGID=100; elsewhere the default 1000:1000 matches the image's "node" user.
if [[ "$(id -u)" == "0" ]]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$DATA_DIR" "$LAVALINK_DIR/plugins"
  chown -R "$PUID:$PGID" "$DATA_DIR" "$LAVALINK_DIR" || log "WARNING: could not change ownership of $DATA_DIR / $LAVALINK_DIR"
  rm -f /tmp/lavalink.pass /tmp/blizzbeat.heartbeat
  log "Running as UID $PUID / GID $PGID."
  export HOME=/tmp
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$0" "$@"
fi

# Lavalink only listens inside the container, so a random password is fine unless you set one.
if [[ -z "${LAVALINK_PASSWORD:-}" ]]; then
  LAVALINK_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
export LAVALINK_PASSWORD
export LAVALINK_HOST=127.0.0.1
export LAVALINK_PORT=2333
umask 077
printf '%s' "$LAVALINK_PASSWORD" > /tmp/lavalink.pass
umask 022

if [[ -n "${SPOTIFY_CLIENT_ID:-}" && -n "${SPOTIFY_CLIENT_SECRET:-}" ]]; then
  export SPOTIFY_ENABLED=true
else
  export SPOTIFY_ENABLED=false
fi

/app/docker/lavalink-config.sh > "$LAVALINK_DIR/application.yml"
log "Generated Lavalink config (Spotify: $SPOTIFY_ENABLED, YouTube plugin ${YOUTUBE_PLUGIN_VERSION:-default})."

cd "$LAVALINK_DIR"
# shellcheck disable=SC2086
java ${JAVA_OPTS:-} -Duser.home=/tmp -jar Lavalink.jar &
LAVALINK_PID=$!

shutdown() {
  log "Stopping..."
  # Stop the bot first so it can save the queue and leave voice while Lavalink is still up.
  if [[ -n "${BOT_PID:-}" ]]; then
    kill -TERM "$BOT_PID" 2>/dev/null || true
    for _ in $(seq 1 18); do kill -0 "$BOT_PID" 2>/dev/null || break; sleep 0.5; done
  fi
  kill -TERM "$LAVALINK_PID" 2>/dev/null || true
  wait || true
  exit 0
}
trap shutdown TERM INT

log "Waiting for Lavalink to start (first start downloads plugins, this can take a minute)..."
ready=false
for _ in $(seq 1 300); do
  if ! kill -0 "$LAVALINK_PID" 2>/dev/null; then
    log "ERROR: Lavalink exited during startup. Check the logs above."
    exit 1
  fi
  if curl -fs -o /dev/null -H "Authorization: $LAVALINK_PASSWORD" "http://127.0.0.1:2333/version"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  log "ERROR: Lavalink did not become ready in time."
  kill -TERM "$LAVALINK_PID" 2>/dev/null || true
  exit 1
fi
log "Lavalink is up. Starting Blizzbeat..."

cd /app
node --disable-warning=ExperimentalWarning src/index.js &
BOT_PID=$!

set +e
wait -n "$LAVALINK_PID" "$BOT_PID"
code=$?
set -e
log "A process exited (code $code). Shutting down the container."
kill -TERM "$BOT_PID" "$LAVALINK_PID" 2>/dev/null || true
wait || true
exit "$code"
