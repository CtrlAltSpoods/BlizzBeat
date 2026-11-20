#!/usr/bin/env bash
# yt-dlp as Lavalink (LavaSrc) calls it: newest available build, Deno for YouTube's JS challenges,
# and cookies from $DATA_DIR/youtube-cookies.txt when present (to get past "confirm you're not a bot").
DATA_DIR="${DATA_DIR:-/data}"
bin=/opt/yt-dlp/yt-dlp
[[ -x "$DATA_DIR/bin/yt-dlp" ]] && bin="$DATA_DIR/bin/yt-dlp"

args=(--js-runtimes "deno:/usr/local/bin/deno" --no-update)
cookies="$DATA_DIR/youtube-cookies.txt"
tmp=""
if [[ -f "$cookies" ]]; then
  # Each call gets its own copy: yt-dlp writes the cookie jar back on exit and calls run in parallel.
  tmp=$(mktemp /tmp/yt-cookies.XXXXXX)
  cp "$cookies" "$tmp"
  args+=(--cookies "$tmp")
fi
"$bin" "${args[@]}" "$@"
code=$?
[[ -n "$tmp" ]] && rm -f "$tmp"
exit $code
