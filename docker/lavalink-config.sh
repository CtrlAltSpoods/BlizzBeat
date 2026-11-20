#!/usr/bin/env bash
# Prints Lavalink's application.yml, built from environment variables.
set -euo pipefail

# YAML double-quoted string.
q() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }
truthy() { [[ "${1,,}" =~ ^(1|true|yes|on)$ ]]; }

YOUTUBE_PLUGIN_VERSION="${YOUTUBE_PLUGIN_VERSION:-1.18.2}"
LAVASRC_VERSION="${LAVASRC_VERSION:-4.8.3}"
YOUTUBE_CLIENTS="${YOUTUBE_CLIENTS:-MUSIC,TV,ANDROID_VR,WEB,WEBEMBEDDED}"
# The TV client is the one that plays with a signed-in account (/config youtube in Discord).
if [[ ",$YOUTUBE_CLIENTS," != *",TV,"* ]]; then
  YOUTUBE_CLIENTS="${YOUTUBE_CLIENTS/MUSIC/MUSIC,TV}"
  [[ ",$YOUTUBE_CLIENTS," != *",TV,"* ]] && YOUTUBE_CLIENTS="TV,$YOUTUBE_CLIENTS"
fi
SPOTIFY_ON=false
truthy "${SPOTIFY_ENABLED:-false}" && SPOTIFY_ON=true

cat <<YAML
server:
  port: 2333
  address: 127.0.0.1 # only reachable from inside the container
  http2:
    enabled: false

lavalink:
  plugins:
    - dependency: $(q "dev.lavalink.youtube:youtube-plugin:${YOUTUBE_PLUGIN_VERSION}")
      snapshot: false
    - dependency: $(q "com.github.topi314.lavasrc:lavasrc-plugin:${LAVASRC_VERSION}")
      snapshot: false
  pluginsDir: $(q "${LAVALINK_DIR:-/opt/lavalink}/plugins")
  server:
    password: $(q "${LAVALINK_PASSWORD:-youshallnotpass}")
    sources:
      youtube: false # replaced by the youtube-source plugin
      bandcamp: true
      soundcloud: true
      twitch: true
      vimeo: true
      nico: false
      http: false
      local: false
    bufferDurationMs: 400
    frameBufferDurationMs: 5000
    opusEncodingQuality: 10
    resamplingQuality: LOW
    trackStuckThresholdMs: 10000
    useSeekGhosting: true
    youtubePlaylistLoadLimit: 6
    playerUpdateInterval: 5
    youtubeSearchEnabled: true
    soundcloudSearchEnabled: true
    gc-warnings: true

plugins:
  youtube:
    enabled: true
    allowSearch: true
    allowDirectVideoIds: true
    allowDirectPlaylistIds: true
    clients:
YAML

IFS=',' read -ra clients <<< "$YOUTUBE_CLIENTS"
for c in "${clients[@]}"; do
  c="$(echo "$c" | tr -d '[:space:]')"
  if [[ -n "$c" ]]; then echo "      - $c"; fi
done

# OAuth is always on but idle until an account is linked. Blizzbeat links it at runtime
# (/config youtube) or from YOUTUBE_OAUTH_REFRESH_TOKEN. YOUTUBE_OAUTH_ENABLED=true without a
# token makes the plugin print its own sign-in code in the logs instead.
echo "    oauth:"
echo "      enabled: true"
if [[ -n "${YOUTUBE_OAUTH_REFRESH_TOKEN:-}" ]]; then
  echo "      refreshToken: $(q "$YOUTUBE_OAUTH_REFRESH_TOKEN")"
  echo "      skipInitialization: true"
elif truthy "${YOUTUBE_OAUTH_ENABLED:-false}"; then
  echo "      skipInitialization: false"
else
  echo "      skipInitialization: true"
fi

if [[ -n "${YOUTUBE_PO_TOKEN:-}" && -n "${YOUTUBE_VISITOR_DATA:-}" ]]; then
  echo "    pot:"
  echo "      token: $(q "$YOUTUBE_PO_TOKEN")"
  echo "      visitorData: $(q "$YOUTUBE_VISITOR_DATA")"
fi

if [[ -n "${YOUTUBE_REMOTE_CIPHER_URL:-}" ]]; then
  echo "    remoteCipher:"
  echo "      url: $(q "$YOUTUBE_REMOTE_CIPHER_URL")"
  if [[ -n "${YOUTUBE_REMOTE_CIPHER_PASSWORD:-}" ]]; then
    echo "      password: $(q "$YOUTUBE_REMOTE_CIPHER_PASSWORD")"
  fi
  echo "      userAgent: \"blizzbeat\""
fi

cat <<YAML
  lavasrc:
    providers:
      - 'ytsearch:"%ISRC%"'
      - 'ytsearch:%QUERY%'
    sources:
      spotify: ${SPOTIFY_ON}
      applemusic: false
      deezer: false
      yandexmusic: false
      flowerytts: false
      youtube: false
      vkmusic: false
      tidal: false
      qobuz: false
      ytdlp: false
      jiosaavn: false
YAML

if [[ "$SPOTIFY_ON" == true ]]; then
  cat <<YAML
    spotify:
      clientId: $(q "${SPOTIFY_CLIENT_ID}")
      clientSecret: $(q "${SPOTIFY_CLIENT_SECRET}")
      countryCode: $(q "${SPOTIFY_COUNTRY_CODE:-US}")
      playlistLoadLimit: 6
      albumLoadLimit: 6
      resolveArtistsInSearch: true
      localFiles: false
YAML
fi

cat <<YAML

logging:
  level:
    root: INFO
    lavalink: INFO
    dev.lavalink.youtube.http.YoutubeOauth2Handler: INFO
  request:
    enabled: false
YAML
