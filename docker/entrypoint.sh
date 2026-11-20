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
if [[ "$(id -u)" == "0" && -z "${BLIZZBEAT_USER_SET:-}" ]]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$DATA_DIR" "$LAVALINK_DIR/plugins"
  chown -R "$PUID:$PGID" "$DATA_DIR" "$LAVALINK_DIR" || log "WARNING: could not change ownership of $DATA_DIR / $LAVALINK_DIR"
  [[ -d /opt/yt-cipher ]] && chown -R "$PUID:$PGID" /opt/yt-cipher/player_cache 2>/dev/null || true
  rm -f /tmp/lavalink.pass /tmp/blizzbeat.heartbeat /tmp/lavalink.pid /tmp/lavalink.restart-requested
  log "Running as UID $PUID / GID $PGID."
  export HOME=/tmp BLIZZBEAT_USER_SET=1
  if [[ "$PUID" != "0" ]]; then
    exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$0" "$@"
  fi
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

# Built-in yt-cipher (decodes YouTube stream signatures) unless you point at your own.
CIPHER_PID=""
BUILTIN_CIPHER=false
if [[ -z "${YOUTUBE_REMOTE_CIPHER_URL:-}" && "${YOUTUBE_BUILTIN_CIPHER:-true}" != "false" && -x /opt/yt-cipher/server ]]; then
  BUILTIN_CIPHER=true
  export YOUTUBE_REMOTE_CIPHER_URL="http://127.0.0.1:8001"
  export YOUTUBE_REMOTE_CIPHER_PASSWORD="$LAVALINK_PASSWORD"
fi

log "Spotify: $SPOTIFY_ENABLED, built-in yt-cipher: $BUILTIN_CIPHER."

# Check for newer Lavalink / plugin releases before starting (AUTO_UPDATE=false to skip).
cd /app && node --disable-warning=ExperimentalWarning src/updater-cli.js || true

start_cipher() {
  [[ "$BUILTIN_CIPHER" == true ]] || return 0
  log "Starting yt-cipher..."
  cd /opt/yt-cipher
  HOST=127.0.0.1 PORT=8001 API_TOKEN="$LAVALINK_PASSWORD" OVERRIDE_PLAYER_VARIANT="${YTCIPHER_PLAYER_VARIANT:-IAS}" \
    MAX_THREADS="${YTCIPHER_THREADS:-2}" ./server &
  CIPHER_PID=$!
  CIPHER_STARTED=$(date +%s)
  cd /app
}

LAVALINK_PID=""
BOT_PID=""
LAVALINK_STARTED=0

start_lavalink() {
  # Regenerated on every (re)start so updates picked by the updater take effect.
  local updates="$DATA_DIR/updates.env" jar="$LAVALINK_DIR/Lavalink.jar" auto_jar=""
  ( set -a; [[ -f "$updates" ]] && . "$updates"; /app/docker/lavalink-config.sh ) > "$LAVALINK_DIR/application.yml"
  [[ -f "$updates" ]] && auto_jar=$(grep -E "^AUTO_LAVALINK_JAR=" "$updates" | cut -d= -f2- | tr -d "'")
  [[ -n "$auto_jar" && -f "$auto_jar" ]] && jar="$auto_jar"
  log "Starting Lavalink ($(basename "$jar"); the first start downloads plugins, which can take a minute)..."
  cd "$LAVALINK_DIR"
  # shellcheck disable=SC2086
  java ${JAVA_OPTS:-} -Duser.home=/tmp -jar "$jar" &
  LAVALINK_PID=$!
  echo "$LAVALINK_PID" > /tmp/lavalink.pid
  LAVALINK_STARTED=$(date +%s)
  cd /app
}

shutdown() {
  log "Stopping..."
  # Stop the bot first so it can save the queue and leave voice while Lavalink is still up.
  if [[ -n "$BOT_PID" ]]; then
    kill -TERM "$BOT_PID" 2>/dev/null || true
    for _ in $(seq 1 18); do kill -0 "$BOT_PID" 2>/dev/null || break; sleep 0.5; done
  fi
  [[ -n "$LAVALINK_PID" ]] && kill -TERM "$LAVALINK_PID" 2>/dev/null || true
  [[ -n "$CIPHER_PID" ]] && kill -TERM "$CIPHER_PID" 2>/dev/null || true
  wait || true
  exit 0
}
trap shutdown TERM INT

# The bot starts right away so slash commands always answer, even while Lavalink is
# starting or broken; it connects to Lavalink as soon as it's up (and retries forever).
start_cipher
start_lavalink
log "Starting Blizzbeat..."
cd /app
node --disable-warning=ExperimentalWarning --dns-result-order=ipv4first src/index.js &
BOT_PID=$!

# Supervise: if Lavalink dies, restart it (with backoff). If the bot dies, stop the container
# so Docker's restart policy brings everything back.
delay=5
cipher_delay=5
set +e
while true; do
  wait -n "$LAVALINK_PID" "$BOT_PID" ${CIPHER_PID:+"$CIPHER_PID"}
  code=$?
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    log "Blizzbeat exited (code $code). Stopping the container."
    break
  fi
  if [[ -n "$CIPHER_PID" ]] && ! kill -0 "$CIPHER_PID" 2>/dev/null; then
    (( $(date +%s) - CIPHER_STARTED > 300 )) && cipher_delay=5
    log "ERROR: yt-cipher exited (code $code). Restarting it in ${cipher_delay}s..."
    sleep "$cipher_delay"
    cipher_delay=$(( cipher_delay * 2 > 120 ? 120 : cipher_delay * 2 ))
    start_cipher
  fi
  if ! kill -0 "$LAVALINK_PID" 2>/dev/null && [[ -f /tmp/lavalink.restart-requested ]]; then
    rm -f /tmp/lavalink.restart-requested
    log "Restarting Lavalink to apply updates..."
    start_lavalink
    continue
  fi
  if ! kill -0 "$LAVALINK_PID" 2>/dev/null; then
    (( $(date +%s) - LAVALINK_STARTED > 300 )) && delay=5
    log "ERROR: Lavalink exited (code $code). Check the Lavalink lines above. Restarting it in ${delay}s..."
    sleep "$delay"
    delay=$(( delay * 2 > 120 ? 120 : delay * 2 ))
    start_lavalink
  fi
done
[[ -n "$CIPHER_PID" ]] && kill -TERM "$CIPHER_PID" 2>/dev/null
kill -TERM "$LAVALINK_PID" 2>/dev/null || true
wait
exit "$code"
