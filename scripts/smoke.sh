#!/usr/bin/env bash
# Runs inside the Blizzbeat image (see .github/workflows/smoke.yml): starts Lavalink, then the smoke test.
set -uo pipefail
export LAVALINK_PASSWORD=smoketest LAVALINK_HOST=127.0.0.1 LAVALINK_PORT=2333 DATA_DIR=/tmp/smoke-data
mkdir -p "$DATA_DIR"
if [[ -x /opt/yt-cipher/server ]]; then
  export YOUTUBE_REMOTE_CIPHER_URL=http://127.0.0.1:8001 YOUTUBE_REMOTE_CIPHER_PASSWORD=$LAVALINK_PASSWORD
  (cd /opt/yt-cipher && HOST=127.0.0.1 PORT=8001 API_TOKEN=$LAVALINK_PASSWORD OVERRIDE_PLAYER_VARIANT=IAS ./server > /tmp/ytcipher.log 2>&1 &)
fi
(cd /app && node --disable-warning=ExperimentalWarning src/updater-cli.js) | tee /tmp/updater.log
/app/docker/lavalink-config.sh > /opt/lavalink/application.yml
cd /opt/lavalink && java -Xmx512m -jar Lavalink.jar > /tmp/lavalink.log 2>&1 &
for _ in $(seq 1 180); do
  curl -fs -o /dev/null -H "Authorization: $LAVALINK_PASSWORD" http://127.0.0.1:2333/version && break
  sleep 1
done
cd /app && node --disable-warning=ExperimentalWarning scripts/smoke.mjs
code=$?
echo "---------------- yt-cipher log ----------------"
tail -20 /tmp/ytcipher.log 2>/dev/null
echo "---------------- Lavalink log (filtered) ----------------"
grep -E "WARN|ERROR|Exception|Caused by|Loaded|plugin|Started Launcher|cipher|Cipher" /tmp/lavalink.log | cut -c1-300 | tail -80
exit $code
