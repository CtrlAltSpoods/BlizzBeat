#!/usr/bin/env bash
# Run inside the image by the smoke workflow: checks yt-dlp + Deno work for YouTube search and streams.
set -uo pipefail
echo "yt-dlp $(/usr/local/bin/blizzbeat-yt-dlp --version), $(deno --version | head -1)"
/usr/local/bin/blizzbeat-yt-dlp -q --no-warnings --flat-playlist -J "ytsearch2:daft punk get lucky" > /tmp/search.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/search.json'))
print('search ok:', [e['title'] for e in d['entries']])
PY
/usr/local/bin/blizzbeat-yt-dlp -q --no-warnings -f bestaudio -J "https://www.youtube.com/watch?v=dQw4w9WgXcQ" > /tmp/stream.json 2> /tmp/stream.err
python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/stream.json'))
    print('stream ok:', d.get('format_id'), d.get('acodec'), d.get('abr'), 'kbps')
except Exception:
    print('stream blocked from CI (expected on datacenter IPs):', open('/tmp/stream.err').read().strip()[:300])
PY

# Can yt-dlp actually download the audio (not just read the page)? Tries each YouTube client and shows
# yt-dlp's warnings (PO token hints) so it's clear which ones YouTube accepts from this network.
echo "--- download test (first 512 KB) ---"
URL="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
for client in default tv tv_simply android_vr web_safari mweb ios web_embedded; do
  args=()
  [[ "$client" != default ]] && args=(--extractor-args "youtube:player_client=$client")
  rm -f /tmp/dl.part
  out=$(timeout 60 /usr/local/bin/blizzbeat-yt-dlp "${args[@]}" -f bestaudio --no-part --http-chunk-size 512K \
    --max-filesize 100M -o - "$URL" 2>/tmp/dl.err | head -c 524288 | wc -c)
  warn=$(grep -E "WARNING|ERROR" /tmp/dl.err | grep -viE "deprecat" | head -2 | cut -c1-200 | tr '\n' ' ')
  printf '%-13s %8s bytes  %s\n' "$client" "$out" "$warn"
done
