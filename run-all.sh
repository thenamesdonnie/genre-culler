#!/bin/bash
# Full genre pipeline on Donnie's Claude Code subscription (RUNNER=cc):
#   artists (two passes so dropped ids get retried) -> normalize -> reapply
#   -> wait for the Last.fm track crawl -> songs (two passes) -> normalize -> reapply
cd "$(dirname "$0")"
export RUNNER=cc
PL=$(grep DEFAULT_PLAYLIST .env | cut -d= -f2)
reapply() { curl -s -X POST -H 'Content-Type: application/json' -d "{\"playlistId\":\"$PL\"}" http://127.0.0.1:3320/api/reapply; echo; }
node classify.js && node classify.js
node classify.js normalize
reapply
echo "ARTISTS DONE"
while pgrep -f '^node lastfm-tracks\.js' >/dev/null; do sleep 15; done
node classify-songs.js && node classify-songs.js
node classify.js normalize
reapply
echo "ALL DONE"
