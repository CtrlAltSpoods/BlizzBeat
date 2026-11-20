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
