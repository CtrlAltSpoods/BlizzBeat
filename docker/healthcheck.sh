#!/usr/bin/env bash
# Healthy when Lavalink answers and the bot has written a heartbeat in the last 2 minutes.
set -eu
pass="$(cat /tmp/lavalink.pass 2>/dev/null || true)"
curl -fs -o /dev/null --max-time 5 -H "Authorization: ${pass}" http://127.0.0.1:2333/version
[ -n "$(find /tmp/blizzbeat.heartbeat -mmin -2 2>/dev/null)" ]
